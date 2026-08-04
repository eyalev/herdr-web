// herdr-web — thin bridge: herdr JSON socket API -> HTTP/WS for the browser.
// See PLAN.md and docs/socket-api-notes.md.
'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');
const herdr = require('./lib/herdr-client');
const { parseAnsiScreen } = require('./lib/ansi');
const { SizeDriver } = require('./lib/size-driver');
const preview = require('./lib/preview');
const cast = require('./lib/cast');
const settings = require('./lib/settings');
const dirs = require('./lib/dirs');

const sizeDriver = new SizeDriver();

// Deliberately NOT process.env.PORT — that leaks from parent shells (bit us:
// inherited PORT=7681 = tmux-web's port).
const PORT = Number(process.env.HERDR_WEB_PORT || 7930);
// SECURITY: this server grants full terminal control of every herdr pane with
// no auth. Default to loopback only; expose deliberately via tailscale serve /
// a reverse proxy, or set HERDR_WEB_BIND=0.0.0.0 if you know what you're doing.
const BIND = process.env.HERDR_WEB_BIND || '127.0.0.1';
const POLL_MS = 300;

function jlog(level, event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, module: 'server', event, ...extra }));
}

// ---------------------------------------------------------------------------
// Session/agent state cache + event fan-out
// ---------------------------------------------------------------------------

const state = {
  snapshot: null,          // last session.snapshot result
  webClients: new Set(),   // ws connections
  eventSub: null,          // herdr subscription handle
  paneIds: [],             // pane ids covered by current subscription
  refreshTimer: null,
  eventsDegraded: false,   // herdr refused or dropped the subscription
};

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of state.webClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

async function refreshSnapshot(reason) {
  try {
    const res = await herdr.request('session.snapshot');
    state.snapshot = res.snapshot;
    broadcast({ type: 'sessions', sessions: sessionList(), eventsDegraded: state.eventsDegraded });
    const ids = (state.snapshot.panes || []).map((p) => p.pane_id).sort();
    if (ids.join(',') !== state.paneIds.join(',')) resubscribe(ids);
  } catch (e) {
    jlog('error', 'snapshot-failed', { reason, error: e.message });
  }
}

// Debounced snapshot refresh — lifecycle events often arrive in bursts.
function scheduleRefresh(reason) {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    refreshSnapshot(reason);
  }, 150);
}

function sessionList() {
  const snap = state.snapshot;
  if (!snap) return [];
  const agentsByPane = new Map((snap.agents || []).map((a) => [a.pane_id, a]));
  return (snap.workspaces || []).map((w) => ({
    workspace_id: w.workspace_id,
    label: w.label,
    focused: w.focused,
    agent_status: w.agent_status,
    panes: (snap.panes || [])
      .filter((p) => p.workspace_id === w.workspace_id)
      .map((p) => {
        const agent = agentsByPane.get(p.pane_id);
        return {
          pane_id: p.pane_id,
          tab_id: p.tab_id,
          focused: p.focused,
          agent_status: p.agent_status,
          agent: agent?.agent || null,
          name: agent?.name || null,
          title: agent?.terminal_title_stripped || p.terminal_title_stripped || null,
          cwd: p.foreground_cwd || p.cwd,
        };
      }),
  }));
}

function resubscribe(paneIds) {
  state.paneIds = paneIds;
  state.eventSub?.close();
  const subs = [
    { type: 'workspace.created' }, { type: 'workspace.closed' }, { type: 'workspace.renamed' },
    { type: 'tab.created' }, { type: 'tab.closed' },
    { type: 'pane.created' }, { type: 'pane.closed' }, { type: 'pane.updated' },
    { type: 'pane.exited' }, { type: 'pane.agent_detected' },
    ...paneIds.flatMap((id) => [
      { type: 'pane.agent_status_changed', pane_id: id },
      { type: 'pane.scroll_changed', pane_id: id },
    ]),
  ];
  state.eventSub = herdr.subscribe(subs, {
    onEvent(msg) {
      const { event, data } = msg;
      if (event === 'pane.agent_status_changed') {
        broadcast({ type: 'agent_status', ...data });
        scheduleRefresh(event);
      } else if (event === 'pane.scroll_changed') {
        pokeWatcher(data.pane_id);
      } else {
        scheduleRefresh(event);
      }
    },
    onClose() {
      // herdr restarted or connection dropped; retry with backoff.
      setTimeout(() => {
        herdr.ensureServer().then(() => refreshSnapshot('resubscribe')).catch((e) => jlog('error', 'herdr-recover-failed', { error: e.message }));
      }, 1000);
    },
    onReady() {
      jlog('info', 'subscribed', { panes: paneIds.length });
      if (state.eventsDegraded) {
        state.eventsDegraded = false;
        broadcast({ type: 'degraded', degraded: false });
      }
    },
    onError(e) {
      // Not cleared: paneIds still match the snapshot, so refreshSnapshot
      // won't resubscribe. Retrying a rejected subscription would loop the
      // same rejection forever while looking like a benign reconnect.
      jlog('error', 'subscribe-failed', { code: e.code, message: e.message });
      if (!state.eventsDegraded) {
        state.eventsDegraded = true;
        broadcast({ type: 'degraded', degraded: true, code: e.code });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Pane watchers — poll `pane.read visible/ansi`, push on change
// ---------------------------------------------------------------------------

const watchers = new Map(); // pane_id -> {clients:Set<ws>, timer, lastText, inFlight}

function pokeWatcher(paneId) {
  const w = watchers.get(paneId);
  if (w) pollPane(paneId, w);
}

async function pollPane(paneId, w) {
  if (w.inFlight) { w.pending = true; return; }
  w.inFlight = true;
  try {
    const res = await herdr.request('pane.read', {
      pane_id: paneId, source: 'visible', format: 'ansi',
    }, { timeoutMs: 5000 });
    const text = res.read.text;
    if (text !== w.lastText) {
      w.lastText = text;
      const rows = parseAnsiScreen(text);
      const data = JSON.stringify({ type: 'screen', pane: paneId, rows });
      for (const ws of w.clients) if (ws.readyState === ws.OPEN) ws.send(data);
    }
  } catch (e) {
    if (e.code === 'not_found') {
      stopWatcher(paneId);
      const data = JSON.stringify({ type: 'pane_gone', pane: paneId });
      for (const ws of w.clients) if (ws.readyState === ws.OPEN) ws.send(data);
    } else {
      jlog('error', 'poll-failed', { pane: paneId, error: e.message });
    }
  } finally {
    w.inFlight = false;
    if (w.pending) { w.pending = false; pollPane(paneId, w); }
  }
}

function watchPane(paneId, ws) {
  let w = watchers.get(paneId);
  if (!w) {
    w = { clients: new Set(), timer: null, lastText: null, inFlight: false, pending: false };
    watchers.set(paneId, w);
    w.timer = setInterval(() => pollPane(paneId, w), POLL_MS);
  }
  w.clients.add(ws);
  w.lastText = null; // force full send to the new client via next poll
  pollPane(paneId, w);
}

function unwatchPane(paneId, ws) {
  const w = watchers.get(paneId);
  if (!w) return;
  w.clients.delete(ws);
  if (w.clients.size === 0) stopWatcher(paneId);
}

function stopWatcher(paneId) {
  const w = watchers.get(paneId);
  if (!w) return;
  clearInterval(w.timer);
  watchers.delete(paneId);
}

// ---------------------------------------------------------------------------
// HTTP + WS
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.get('/api/sessions', async (_req, res) => {
  await refreshSnapshot('api-sessions');
  res.json({ sessions: sessionList() });
});

app.post('/api/workspaces', async (req, res) => {
  let { cwd, label, command } = req.body || {};
  try {
    if (cwd && cwd.startsWith('~')) cwd = path.join(require('node:os').homedir(), cwd.slice(1));
    // Reject nonexistent dirs — herdr silently falls back to $HOME, which
    // surprises users (and leaked a home listing into a demo recording).
    if (cwd && !require('node:fs').existsSync(cwd)) {
      return res.status(400).json({ error: `directory does not exist: ${cwd}` });
    }
    const created = await herdr.request('workspace.create', { cwd, label });
    if (command) {
      await herdr.request('pane.send_text', { pane_id: created.root_pane.pane_id, text: `${command}\n` });
    }
    scheduleRefresh('workspace-created-api');
    res.json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/workspaces/:id', async (req, res) => {
  try {
    await herdr.request('workspace.close', { workspace_id: req.params.id });
    scheduleRefresh('workspace-closed-api');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Preview (Tier 1) and Cast (Tier 2)
// ---------------------------------------------------------------------------

app.get('/api/dirs', async (req, res) => {
  const cwds = (state.snapshot?.panes || []).map((p) => p.foreground_cwd || p.cwd);
  res.json({ dirs: await dirs.list(req.query.q, cwds) });
});

app.get('/api/settings', (_req, res) => res.json(settings.load()));

app.put('/api/settings', (req, res) => {
  const patch = req.body || {};
  if (patch.agentCommand !== undefined && typeof patch.agentCommand !== 'string') {
    return res.status(400).json({ error: 'agentCommand must be a string' });
  }
  const saved = settings.save(patch);
  jlog('info', 'settings-saved', { agentCommand: saved.agentCommand });
  res.json(saved);
});

app.get('/api/ports', async (_req, res) => {
  res.json({ ports: await preview.listPorts(PORT) });
});

// Enabling a port is explicit: proxying arbitrary loopback ports would widen
// what anything reaching this bridge can touch.
app.post('/api/preview/enable', (req, res) => {
  const port = Number(req.body?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'invalid port' });
  }
  preview.allow(port);
  jlog('info', 'preview-enabled', { port });
  res.json({ ok: true, port });
});

app.get('/api/cast/targets', async (_req, res) => {
  try {
    res.json({ targets: await cast.listTargets(), cdpPort: cast.CDP_PORT });
  } catch (e) {
    res.status(503).json({ error: e.message, cdpPort: cast.CDP_PORT });
  }
});

// Proxy for enabled preview ports — must sit before the static handler so a
// dev server's /index.html wins over ours when routed by Referer.
app.use((req, res, next) => { if (!preview.handle(req, res)) next(); });

// index.html must never be cached (PWA staleness trap — tmux-web lesson).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const castWss = new WebSocketServer({ noServer: true });

// One upgrade handler for three consumers: the session WS, cast sessions, and
// proxied dev-server sockets (Vite HMR et al).
server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (path === '/cast') {
    castWss.handleUpgrade(req, socket, head, (ws) => castWss.emit('connection', ws, req));
  } else if (!preview.handleUpgrade(req, socket, head)) {
    socket.destroy();
  }
});

castWss.on('connection', (ws, req) => {
  const targetId = new URL(req.url, 'http://x').searchParams.get('target');
  cast.attach(ws, targetId).catch((e) => {
    jlog('error', 'cast-attach-failed', { error: e.message });
    try { ws.send(JSON.stringify({ type: 'error', error: e.message })); ws.close(); } catch { /* ignore */ }
  });
});

wss.on('connection', (ws) => {
  state.webClients.add(ws);
  let watched = null;
  jlog('info', 'ws-open', { clients: state.webClients.size });
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList(), eventsDegraded: state.eventsDegraded }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      switch (msg.type) {
        case 'watch': {
          if (watched) unwatchPane(watched, ws);
          watched = msg.pane;
          if (watched) {
            watchPane(watched, ws);
            // Mark seen on herdr's side too: its done/seen state follows the
            // phantom TUI client's focus, so focus what the web user views.
            herdr.request('agent.focus', { target: watched }).catch(() => {});
          }
          break;
        }
        case 'input': { // literal text
          await herdr.request('pane.send_text', { pane_id: msg.pane, text: msg.text });
          break;
        }
        case 'key': { // named keys, e.g. ["enter"], ["ctrl+c"]
          await herdr.request('pane.send_keys', { pane_id: msg.pane, keys: msg.keys });
          break;
        }
        case 'submit': {
          // Prefer herdr's agent.prompt — it submits text+Enter while
          // honoring the pane's live bracketed-paste mode, which raw
          // send_input does not (drafts got stuck in CC's input box).
          // Falls back to one atomic pane.send_input for plain shell panes.
          if (msg.text) {
            try {
              await herdr.request('agent.prompt', { target: msg.pane, text: msg.text });
            } catch (e) {
              await herdr.request('pane.send_input', { pane_id: msg.pane, text: msg.text, keys: ['enter'] });
            }
          } else {
            await herdr.request('pane.send_keys', { pane_id: msg.pane, keys: ['enter'] });
          }
          break;
        }
        case 'resize': { // desired pane size from the client's viewport fit
          if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            sizeDriver.setPaneSize(Math.round(msg.cols), Math.round(msg.rows));
          }
          break;
        }
        case 'scrollback': {
          const res = await herdr.request('pane.read', {
            pane_id: msg.pane, source: 'recent', format: 'ansi', lines: Math.min(msg.lines || 300, 2000),
          });
          ws.send(JSON.stringify({ type: 'scrollback', pane: msg.pane, rows: parseAnsiScreen(res.read.text) }));
          break;
        }
        default:
          jlog('warn', 'ws-unknown-type', { t: msg.type });
      }
    } catch (e) {
      jlog('error', 'ws-handler-failed', { t: msg.type, error: e.message });
      ws.send(JSON.stringify({ type: 'error', for: msg.type, error: e.message }));
    }
  });

  ws.on('close', () => {
    state.webClients.delete(ws);
    if (watched) unwatchPane(watched, ws);
    jlog('info', 'ws-close', { clients: state.webClients.size });
  });
});

// ---------------------------------------------------------------------------

(async () => {
  const pong = await herdr.ensureServer();
  jlog('info', 'herdr-ready', { version: pong.version, protocol: pong.protocol });
  await refreshSnapshot('startup');
  server.listen(PORT, BIND, () => jlog('info', 'listening', { port: PORT, bind: BIND }));
})().catch((e) => {
  jlog('error', 'startup-failed', { error: e.message });
  process.exit(1);
});

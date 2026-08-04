// Thin client for the herdr JSON socket API (newline-delimited JSON over a
// Unix socket). See docs/socket-api-notes.md for the empirical API map.
'use strict';

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SOCKET_PATH = process.env.HERDR_SOCKET_PATH
  || path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');

let reqCounter = 0;

function connectSocket() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

// Attach a newline-delimited-JSON line parser to a socket.
function onJsonLines(sock, handler) {
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', module: 'herdr-client', event: 'bad-json-line', line: line.slice(0, 200) }));
        continue;
      }
      handler(msg);
    }
  });
}

// One request/response on a fresh connection. herdr handles concurrent
// short-lived connections fine and this avoids response interleaving logic.
function request(method, params = {}, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `hw_${++reqCounter}_${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val); } };
    const timer = setTimeout(() => finish(reject, new Error(`herdr ${method} timed out after ${timeoutMs}ms`)), timeoutMs);

    connectSocket().then((sock) => {
      sock.on('error', (e) => finish(reject, e));
      onJsonLines(sock, (msg) => {
        if (msg.id !== id) return;
        sock.end();
        if (msg.error) {
          const err = new Error(`herdr ${method}: ${msg.error.code}: ${msg.error.message}`);
          err.code = msg.error.code;
          finish(reject, err);
        } else {
          finish(resolve, msg.result);
        }
      });
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    }, (e) => finish(reject, e));
  });
}

// Long-lived subscription connection. onEvent receives {event, data} lines.
// onReady fires once herdr acks the subscription; onError fires on a rejected
// subscribe, a socket error, or a failed connect. herdr rejects the whole
// request if any single subscription type is unknown, so a caller that ignores
// onError can believe it is subscribed while receiving nothing.
// Returns {close}. Caller is responsible for recreating on 'close'.
function subscribe(subscriptions, { onEvent, onClose, onError, onReady } = {}) {
  let closed = false;
  const state = { sock: null };
  connectSocket().then((sock) => {
    if (closed) { sock.end(); return; }
    state.sock = sock;
    sock.on('error', (e) => { if (!closed) onError?.(e); });
    sock.on('close', () => { if (!closed) onClose?.(); });
    onJsonLines(sock, (msg) => {
      if (closed) return;
      if (msg.event) onEvent(msg);
      else if (msg.error) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', module: 'herdr-client', event: 'subscribe-error', error: msg.error }));
        const err = new Error(`herdr events.subscribe: ${msg.error.code}: ${msg.error.message}`);
        err.code = msg.error.code;
        onError?.(err);
      } else if (msg.result?.type === 'subscription_started') onReady?.();
    });
    sock.write(JSON.stringify({ id: `sub_${++reqCounter}`, method: 'events.subscribe', params: { subscriptions } }) + '\n');
  }, (e) => { if (!closed) { onError?.(e); onClose?.(); } });
  return {
    close() { closed = true; state.sock?.end(); },
  };
}

async function ping() {
  return request('ping', {}, { timeoutMs: 3000 });
}

// Ensure a herdr server is running; spawn a detached headless one if not.
async function ensureServer() {
  try { return await ping(); } catch (_) { /* not running */ }
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'info', module: 'herdr-client', event: 'spawning-herdr-server' }));
  // Strip Claude Code session markers: herdr passes its env to every pane,
  // and a CC agent inheriting CLAUDE_CODE_CHILD_SESSION shows a persistent
  // "Transcript saving is off" warning (happens when the bridge itself was
  // launched from inside a CC session).
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k];
  const child = spawn('herdr', ['server'], { detached: true, stdio: 'ignore', env });
  child.unref();
  const deadline = Date.now() + 15000;
  let lastErr;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try { return await ping(); } catch (e) { lastErr = e; }
  }
  throw new Error(`herdr server did not come up: ${lastErr?.message}`);
}

module.exports = { request, subscribe, ping, ensureServer, SOCKET_PATH };

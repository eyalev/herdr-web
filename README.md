# herdr-web

Mobile-first web UI for the [herdr](https://herdr.dev) agent multiplexer —
view and drive your coding agents (Claude Code first) from a phone browser,
backed by herdr's persistent PTY sessions and its semantic agent states
(idle / working / blocked / done).

**[Watch the 40-second desktop demo →](docs/demos/desktop-browser.md)** — an
agent restyling an app while you watch the real page repaint beside it.

https://github.com/user-attachments/assets/7062da6d-f65e-45e7-a695-1d6bbe116a03

**Every demo, one page each: [docs/demos.md](docs/demos.md)** ·
Agent-to-agent coordination: [docs/agent-coordination.md](docs/agent-coordination.md)

## What you get

- **Live terminal view** of any herdr pane, rendered as native DOM rows at a
  phone-readable width — herdr's runtime is resized to fit your screen, so
  Claude Code *reflows* to ~50 columns instead of squinting at 80.
- **Agent-status tabs** — herdr's killer feature, front and center: one tab
  per pane with a colored state dot (working / blocked / done / idle),
  sorted by attention.
- **Never miss an approval**: blocked agents raise a toast in-app and a
  system notification when the app is in the background; a bell chip cycles
  you through everything that needs you. "Done while you weren't looking"
  is tracked as unseen until you view it (synced with herdr's own seen state).
- **Smooth scrollback** — history is prefetched above the live screen in one
  scroll container; swiping into the past is plain native scrolling.
- **Quick keys + input** — Esc, Tab, ⇧Tab, Ctrl-C, arrows, Enter; text
  submits atomically via herdr's `agent.prompt` (no half-pasted prompts).
- **A Claude Code menu** — one `✳ CC` chip that knows what the pane is: launch
  your configured command (`ccpc`, `claude --continue`, …) in a shell, or drive
  a running agent with `/model`, `/compact`, `/clear`, mode cycling and rewind.
- **Directory picker** — `📁 cd` finds projects by zoxide frecency, git repos
  and open panes, so you never type a path on a phone.
- **Text size you control** — `A−`/`A+` in the keys row; the pane's column
  count follows the size, so the terminal fills the width at any of them.
- **An integrated browser that isn't a pixel stream** — see below.
- **PWA** — installable, no build step, three runtime dependencies.

## The integrated browser

A terminal can only *show pictures of* a web page — hence the ingenious
kitty-graphics/chafa pipelines other herdr browser plugins need. herdr-web
is already a browser, so it can skip that entirely:

**Preview (default).** The bridge reverse-proxies a local dev server under
this same origin and shows it in an iframe, so you get the **real page** —
selectable text, native pinch-zoom and momentum scroll, a real keyboard,
forms and file pickers. Bandwidth is the app's own assets, not JPEG frames
of them. Two side effects worth having: your plain-HTTP dev server inherits
the bridge's HTTPS, and no dev port needs its own tunnel. Ports are
discovered automatically and ranked dev-server-first, and any
`http://localhost:PORT` in agent output is a tap target — no modifier key.

**Cast (fallback, and for watching agents).** For pages that refuse framing,
need your logged-in session, or are simply remote, herdr-web attaches to a
Chrome DevTools endpoint (`HERDR_WEB_CDP_PORT`, default 9222 — i.e. the
browser your agent automates) and streams `Page.startScreencast` frames.
Because the sink is a browser rather than a terminal, frames land in an
`<img>` with no cell quantization, taps and drags map straight onto page
pixels as real `Input` events, and the cast page is *reflowed to your phone*
via a device-metrics override — reverted on detach, so an agent's browser is
never left resized behind its back.

**Takeover, page-errors→agent and the element picker** turn the cast into part
of the loop: watch the agent browse, take control when you need to, send the
page's real console errors into the prompt, and tap an element to aim your next
instruction at it — see [the agent-loop demo](docs/demos/agent-loop.md).

Demos: [desktop, side by side](docs/demos/desktop-browser.md) ·
[preview on a phone](docs/demos/preview-tap.md) ·
[cast a real Chrome](docs/demos/cast-browser.md).

## Install

### As a herdr plugin

```bash
herdr plugin install eyalev/herdr-web
```

The plugin's startup hook launches the bridge on `http://127.0.0.1:7930`
whenever herdr starts (and there are Start/Stop actions in herdr's UI).

### Standalone

```bash
git clone https://github.com/eyalev/herdr-web
cd herdr-web && npm install
node server.js        # http://127.0.0.1:7930
```

Requires Node 18+, a running (or startable) herdr ≥ 0.7. `node-pty` is an
optional dependency — without it everything works, but the terminal stays at
herdr's 80×24 headless default instead of fitting your phone.

## Reaching it from your phone

The server deliberately binds `127.0.0.1` only — **it grants full terminal
control of every pane with no auth**. Expose it through something that
handles transport security for you:

- **Tailscale** (recommended): `tailscale serve --bg --https=17930 http://127.0.0.1:7930`
  then open `https://<machine>.<tailnet>.ts.net:17930` on your phone.
  HTTPS also unlocks notifications and PWA install.
- Any authenticated reverse proxy works the same way.
- `HERDR_WEB_BIND=0.0.0.0` exists if you really know what you're doing.

## How it works

```
 phone browser (PWA)
   │ ▲ screens/agent-states (WebSocket) · keys, prompts (WS/HTTP)
   ▼ │
 herdr-web bridge :7930
   server.js ── lib/ansi.js (ANSI → grid)
   │            lib/size-driver.js (fit-to-phone resize)
   ▼  JSON socket (session.snapshot, events, agent.prompt, keys)
 herdr daemon ──▶ PTY panes (Claude Code agents, …)
```

herdr's server owns the PTYs and already runs a full terminal emulator, so
there is **no xterm and no escape-sequence parsing pipeline here**: the
bridge polls `pane.read {source: "visible", format: "ansi"}` for the pane
you're viewing (300 ms, plus `pane.scroll_changed` events for snappiness),
parses the SGR-only styled lines into spans (~100 lines of code), and ships
them over a WebSocket. Background panes cost nothing — their status dots
come from pushed `pane.agent_status_changed` events.

The one clever bit: the JSON API can't resize the headless runtime, but the
runtime follows the foreground *client's* terminal size — so the bridge
keeps a real `herdr` TUI client in a hidden pty and resizes it to whatever
your browser reports. That's what makes agents reflow to phone width.

The full empirical API recon that shaped this design:
[docs/socket-api-notes.md](docs/socket-api-notes.md).

## Configuration

| Env var | Default | |
|---|---|---|
| `HERDR_WEB_PORT` | `7930` | HTTP/WS port |
| `HERDR_WEB_BIND` | `127.0.0.1` | Listen address |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr API socket |
| `HERDR_WEB_CDP_PORT` | `9222` | Chrome DevTools endpoint used by Cast |
| `HERDR_WEB_CONFIG_DIR` | `~/.config/herdr-web` | Where `settings.json` lives |

Settings (the ⚙ button) are stored server-side in `settings.json`, so your
phone and your laptop agree. The one that matters most is **agent command**:
it is typed into the pane's *interactive shell* when a session starts an
agent, so your own aliases and wrappers work — `ccpc`, `claude --continue`,
`codex`, whatever you actually launch — not just binaries on PATH.

Recommended herdr config (`~/.config/herdr/config.toml`) so headless panes
get full width:

```toml
[ui]
sidebar_start_collapsed = true
sidebar_collapsed_mode = "hidden"
```

**Can't scroll up in a Claude Code pane?** Its `fullscreen` renderer keeps
the conversation on the alternate screen and nothing in terminal scrollback,
so `pane.read {source: "recent"}` has nothing above the current screen to
return. `/tui default` switches to the classic renderer, which keeps the
conversation in scrollback and makes scrolling work; `/tui fullscreen`
switches back. Note that this is a global Claude Code setting: it takes
effect immediately in every running session, not only the one you ran it in.
A plain shell pane is unaffected.

## Status

Early but real — built and verified against herdr 0.7.5 (protocol 17) with
emulator-tested UX (see [docs/demos.md](docs/demos.md) for the evidence).
Expect herdr's pre-1.0 API to move. Issues and PRs welcome.

## License

MIT

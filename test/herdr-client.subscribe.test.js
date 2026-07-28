'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { FakeHerdr, sendLine } = require('../test-helpers/fake-herdr');

// herdr-client reads HERDR_SOCKET_PATH into a module-level const at require
// time, so each test needs a fresh module instance pointed at its own socket.
const CLIENT_PATH = require.resolve('../lib/herdr-client');

let fake;
let herdr;

function loadClient(socketPath) {
  process.env.HERDR_SOCKET_PATH = socketPath;
  delete require.cache[CLIENT_PATH];
  return require('../lib/herdr-client');
}

beforeEach(async () => {
  fake = new FakeHerdr();
  herdr = loadClient(await fake.listen());
});

afterEach(async () => {
  delete require.cache[CLIENT_PATH];
  delete process.env.HERDR_SOCKET_PATH;
  await fake.close();
});

// Every test resolves from inside a callback the unfixed client never invokes,
// so without an explicit timeout a regression hangs the runner instead of
// failing it. node:test has no default per-test timeout.
test('rejected subscribe reaches onError with herdr\'s code', { timeout: 3000 }, async () => {
  fake.on('events.subscribe', (msg, sock) => {
    // herdr answers rejections with an empty id, not the request's own.
    sendLine(sock, {
      id: '',
      error: { code: 'invalid_request', message: 'unknown variant `pane.updated`, expected one of ...' },
    });
  });

  const err = await new Promise((resolve) => {
    const sub = herdr.subscribe([{ type: 'pane.updated' }], {
      onEvent: () => {},
      onError: (e) => { sub.close(); resolve(e); },
    });
  });

  assert.equal(err.code, 'invalid_request');
});

test('acked subscribe fires onReady once and then delivers events', { timeout: 3000 }, async () => {
  let readyCount = 0;
  let serverSock;

  fake.on('events.subscribe', (msg, sock) => {
    serverSock = sock;
    sendLine(sock, { id: msg.id, result: { type: 'subscription_started' } });
  });

  const event = await new Promise((resolve) => {
    const sub = herdr.subscribe([{ type: 'pane.agent_status_changed', pane_id: 'p1' }], {
      // Pushing from inside onReady mirrors the real server, which sends the
      // ack before any event, and keeps the ordering deterministic.
      onReady: () => {
        readyCount++;
        sendLine(serverSock, {
          event: 'pane_agent_status_changed',
          data: { pane_id: 'p1', agent_status: 'working' },
        });
      },
      onEvent: (msg) => { sub.close(); resolve(msg); },
    });
  });

  assert.equal(readyCount, 1);
  assert.equal(event.data.pane_id, 'p1');
});

test('failure to connect reaches onError', { timeout: 3000 }, async () => {
  herdr = loadClient(path.join(fake.dir, 'nobody-home.sock'));

  const err = await new Promise((resolve) => {
    const sub = herdr.subscribe([{ type: 'workspace.created' }], {
      onEvent: () => {},
      onError: (e) => { sub.close(); resolve(e); },
    });
  });

  assert.ok(err);
});

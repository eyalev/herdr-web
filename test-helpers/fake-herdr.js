// Scriptable stand-in for the herdr socket: newline-delimited JSON over a
// unix socket in a temp dir, with one handler per method. Lives outside
// test/ because `node --test` treats every .js file under a directory named
// test as a test file, and offers no way to exclude one before Node 22.
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class FakeHerdr {
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
    this.socketPath = path.join(this.dir, 's.sock');
    this.handlers = new Map();
    this.sockets = new Set();
    this.server = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      sock.on('error', () => {});
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch (e) { continue; }
          const handler = this.handlers.get(msg.method);
          if (handler) handler(msg, sock);
        }
      });
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
    return this;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener('error', reject);
        resolve(this.socketPath);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      for (const sock of [...this.sockets]) sock.destroy();
      this.server.close(() => {
        fs.rmSync(this.dir, { recursive: true, force: true });
        resolve();
      });
    });
  }
}

function sendLine(sock, obj) {
  sock.write(JSON.stringify(obj) + '\n');
}

module.exports = { FakeHerdr, sendLine };

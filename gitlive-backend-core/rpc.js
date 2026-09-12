// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// The backend.sock wire protocol (spec: gitlive-backend-spec.md).
//
// Newline-delimited JSON, one message per line. A message that carries a
// binary payload (storage.put's request, storage.get's response when a
// blob is found) adds a `binaryBytes` field to its JSON header and is
// immediately followed by exactly that many raw bytes, no delimiter — the
// receiver already knows the length from the header, so there's nothing
// to escape or base64-encode.
//
// This file is the one place the framing is implemented; gitlive-client
// (as the RPC caller) and gitlive-backend (as the RPC server) both use it
// directly rather than re-implementing the protocol.

const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');

function readMessages(socket, onMessage) {
  let buf = Buffer.alloc(0);
  let pendingHeader = null;
  let pendingRemaining = 0;

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    drain();
  });

  function drain() {
    for (;;) {
      if (pendingHeader) {
        if (buf.length < pendingRemaining) return;
        const bytes = buf.subarray(0, pendingRemaining);
        buf = buf.subarray(pendingRemaining);
        const header = pendingHeader;
        pendingHeader = null;
        onMessage(header, bytes);
        continue;
      }
      const nl = buf.indexOf(0x0a); // '\n'
      if (nl === -1) return;
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      if (line.length === 0) continue;
      let header;
      try {
        header = JSON.parse(line);
      } catch {
        continue; // malformed line — drop rather than crash the connection
      }
      if (typeof header.binaryBytes === 'number' && header.binaryBytes > 0) {
        pendingHeader = header;
        pendingRemaining = header.binaryBytes;
        continue;
      }
      onMessage(header, null);
    }
  }
}

function writeMessage(socket, header, payload) {
  const framed = payload ? { ...header, binaryBytes: payload.length } : header;
  socket.write(JSON.stringify(framed) + '\n');
  if (payload) socket.write(payload);
}

/** Client side: make one RPC call over the app's backend.sock. */
function rpcCall(socketPath, op, args, payload, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(socketPath);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(Object.assign(new Error('gitlive backend rpc timed out'), { code: 'ETIMEDOUT' })),
      timeoutMs
    );

    socket.on('error', fail);
    socket.on('connect', () => writeMessage(socket, { id, op, args }, payload));

    readMessages(socket, (header, binary) => {
      // NOTE: settled is set here, directly — do not route this through
      // fail(), which no-ops when settled is already true. That bug once
      // made a real daemon-side error (e.g. CONFLICT) hang the caller
      // forever instead of rejecting; caught by the integration test.
      if (header.id !== id || settled) return;
      clearTimeout(timer);
      settled = true;
      socket.end();
      if (!header.ok) {
        reject(Object.assign(new Error(header.error?.message || 'gitlive backend rpc error'), {
          code: header.error?.code || 'INTERNAL',
        }));
        return;
      }
      resolve(binary ? { ...header.result, buffer: binary } : header.result);
    });
  });
}

/** Fast existence check used by gitlive-client to decide standalone vs. daemon mode. */
function probeSocket(socketPath, timeoutMs = 50) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Daemon side: listen on socketPath, dispatch each request through callOp.
 * getCtxForRequest() resolves which app's ctx to use per request — the
 * daemon may hold more than one app open at once.
 */
function createRpcServer(socketPath, getCtxForRequest, callOp) {
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath); // stale socket left behind by a crashed daemon
  }

  const server = net.createServer((socket) => {
    readMessages(socket, async (header, binary) => {
      const { id, op, args } = header;
      try {
        const ctx = getCtxForRequest();
        const result = await callOp(ctx, op, args, binary);
        if (result && Buffer.isBuffer(result.buffer)) {
          const { buffer, ...rest } = result;
          writeMessage(socket, { id, ok: true, result: rest }, buffer);
        } else {
          writeMessage(socket, { id, ok: true, result: result ?? null });
        }
      } catch (err) {
        writeMessage(socket, {
          id,
          ok: false,
          error: { code: err.code || 'INTERNAL', message: err.message || String(err) },
        });
      }
    });
    socket.on('error', () => {}); // client disconnects mid-call are routine, not a daemon crash
  });

  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  return server;
}

module.exports = { rpcCall, probeSocket, createRpcServer };

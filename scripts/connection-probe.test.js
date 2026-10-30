/** Wake probe, other-tab and unreachable notices with a fake socket and a fake clock (audits CONN-3/5/6). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectionMonitor, PROBE_TIMEOUT_MS } from '../client/src/connection.ts';

function fakeSocket({ connected = true, replies = true } = {}) {
  const listeners = {};
  const socket = {
    connected,
    closes: 0,
    probes: [],
    connects: 0,
    io: { engine: { close() { socket.closes++; } } },
    timeout(ms) {
      return {
        emitWithAck(event, payload) {
          socket.probes.push({ ms, event, payload });
          return replies ? Promise.resolve({ serverTime: 1 }) : Promise.reject(new Error('operation has timed out'));
        },
      };
    },
    on(event, listener) { (listeners[event] ??= []).push(listener); },
    fire(event, ...args) { for (const listener of listeners[event] ?? []) listener(...args); },
    connect() { socket.connects++; },
  };
  return socket;
}

function monitor(socket) {
  let clock = 0;
  const notices = [];
  const m = createConnectionMonitor(socket, { onNotice: (n) => notices.push(n), now: () => clock });
  return { m, notices, advance: (ms) => { clock += ms; } };
}

test('a short absence does not probe', async () => {
  const socket = fakeSocket();
  const { m, advance } = monitor(socket);
  m.hidden(); advance(4999); await m.visible();
  assert.equal(socket.probes.length, 0);
});

test('a disconnected socket is not probed', async () => {
  const socket = fakeSocket({ connected: false });
  const { m, advance } = monitor(socket);
  m.hidden(); advance(60_000); await m.visible();
  assert.equal(socket.probes.length, 0);
});

test('a reply keeps the connection', async () => {
  const socket = fakeSocket();
  const { m, advance } = monitor(socket);
  m.hidden(); advance(60_000); await m.visible();
  assert.deepEqual(socket.probes, [{ ms: PROBE_TIMEOUT_MS, event: 'clock:ping', payload: {} }]);
  assert.equal(socket.closes, 0);
});

test('no reply within 2 s while still connected closes the engine exactly once', async () => {
  const socket = fakeSocket({ replies: false });
  const { m, advance } = monitor(socket);
  m.hidden(); advance(60_000);
  // A second wake signal while the first probe runs must not close twice.
  await Promise.all([m.visible(), m.restored()]);
  assert.equal(socket.closes, 1);
});

test('the server taking the seat for another tab shows that notice, and Use here reconnects', () => {
  const socket = fakeSocket();
  const { m, notices } = monitor(socket);
  socket.fire('disconnect', 'transport close');
  assert.deepEqual(notices, []);
  socket.fire('disconnect', 'io server disconnect');
  assert.deepEqual(notices, ['otherTab']);
  m.reclaim();
  assert.equal(socket.connects, 1);
  assert.equal(m.notice, 'none');
});

test('three connect errors in a row show the unreachable notice; connecting clears it', () => {
  const socket = fakeSocket({ connected: false });
  const { m, notices } = monitor(socket);
  socket.fire('connect_error'); socket.fire('connect_error');
  assert.deepEqual(notices, []);
  socket.fire('connect_error');
  assert.deepEqual(notices, ['unreachable']);
  socket.fire('connect');
  assert.equal(m.notice, 'none');
});

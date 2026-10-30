/** Unjoined sockets are capped per address; joins, leaves, kicks and disconnects count exactly once (audit SEC-10). */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSocketLimits } from '../server/socket/socketLimits.ts';
import { Room } from '../server/game/Room.ts';
import { registerSocketHandlers } from '../server/socket/handlers.ts';

const REMOTE = '192.168.1.50';

class FakeSocket extends EventEmitter {
  constructor(id, address = REMOTE) {
    super();
    this.id = id;
    this.data = {};
    this.handshake = { address };
  }
  join() {}
  leave() {}
  disconnect() { this.emit('disconnect'); }
}

/** Runs the limit middleware, then the `connection` step, the way Socket.IO would. */
function admit(limits, socket, { connect = true } = {}) {
  let admitted = false;
  limits.middleware(socket, (err) => { admitted = !err; });
  if (admitted && connect) limits.connected(socket);
  return admitted;
}

test('the 33rd unjoined socket from one address is refused; loopback is never capped', () => {
  const limits = createSocketLimits(32);
  for (let i = 0; i < 32; i++) assert.ok(admit(limits, new FakeSocket(`s${i}`)));
  assert.equal(admit(limits, new FakeSocket('s32')), false);
  assert.ok(admit(limits, new FakeSocket('other', '192.168.1.51')), 'another address has its own budget');
  for (let i = 0; i < 100; i++) assert.ok(admit(limits, new FakeSocket(`l${i}`, '127.0.0.1')));
  assert.equal(limits.count('127.0.0.1'), 0);
});

test('a socket that passes the check but closes before connecting is never counted', () => {
  // Socket.IO drops such a socket silently: no `connection`, no `disconnect` to return a count.
  const limits = createSocketLimits(32);
  for (let i = 0; i < 40; i++) assert.ok(admit(limits, new FakeSocket(`gone${i}`), { connect: false }));
  assert.equal(limits.count(REMOTE), 0);
});

function harness(limits) {
  const room = new Room();
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room, limits);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    assert.ok(admit(limits, socket));
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  return { room, connect, send };
}

test('joining frees a slot, leaving or a kick takes it again, and disconnects never double-count', async (t) => {
  const limits = createSocketLimits(32);
  const { room, connect, send } = harness(limits);
  t.after(() => { room.engine.reset(); for (const timer of room.removalTimers.values()) clearTimeout(timer); });

  const host = connect('host');
  const player = connect('player');
  assert.equal(limits.count(REMOTE), 2);
  await send(host, 'session:join', { nickname: 'Host' });
  await send(host, 'role:choose', { role: 'host' });
  await send(player, 'session:join', { nickname: 'Player' });
  assert.equal(limits.count(REMOTE), 0, 'joined sockets do not count');

  assert.equal((await send(player, 'session:leave')).ok, true);
  assert.equal(limits.count(REMOTE), 1, 'a socket that left counts as unjoined again');
  await send(player, 'session:join', { nickname: 'Player again' });
  assert.equal(limits.count(REMOTE), 0);

  const pid = player.data.pid;
  assert.equal((await send(host, 'participant:kick', { targetId: pid })).ok, true);
  assert.equal(limits.count(REMOTE), 1, 'a kicked socket counts as unjoined again');

  player.disconnect();
  player.disconnect(); // a repeated disconnect must not go negative
  host.disconnect();
  assert.equal(limits.count(REMOTE), 0);
});

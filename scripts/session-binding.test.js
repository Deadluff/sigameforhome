/** One socket must never receive another seat's private state or keep stale permissions. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Room } from '../server/game/Room.js';
import { registerSocketHandlers } from '../server/socket/handlers.js';

class FakeSocket extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.data = {};
  }
  join() {}
  leave() {}
  disconnect() { this.emit('disconnect'); }
}

test('a joined socket cannot switch seats and a replaced socket loses access', async () => {
  const room = new Room();
  let onConnection;
  const io = {
    sockets: { sockets: new Map() },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to() { return { emit() {} }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => {
    const socket = new FakeSocket(id);
    io.sockets.sockets.set(id, socket);
    onConnection(socket);
    return socket;
  };
  const send = (socket, event, payload = {}) =>
    new Promise((resolve) => socket.emit(event, payload, resolve));

  const first = connect('first');
  const host = await send(first, 'session:join', { nickname: 'Host' });
  assert.equal(host.ok, true);
  assert.equal((await send(first, 'role:choose', { role: 'host' })).ok, true);
  const second = connect('second');
  const player = await send(second, 'session:join', { nickname: 'Player' });
  assert.equal(player.ok, true);

  const switchSeat = await send(first, 'session:resume', { token: player.token });
  assert.equal(switchSeat.ok, false);
  assert.match(switchSeat.error, /Already joined/);
  assert.equal(room.resume(host.token).socketId, first.id);
  assert.equal(room.resume(player.token).socketId, second.id);

  const replacement = connect('replacement');
  assert.equal((await send(replacement, 'session:resume', { token: host.token })).resumed, true);
  const staleAction = await send(first, 'settings:update', { ignoreWrong: true });
  assert.equal(staleAction.ok, false);
  assert.match(staleAction.error, /Session is no longer active/);
  assert.equal(room.settings.ignoreWrong, false);
  assert.equal((await send(replacement, 'settings:update', { ignoreWrong: true })).ok, true);
  assert.equal(room.settings.ignoreWrong, true);
});

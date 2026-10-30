/** A locked room seats newcomers as spectators until the host seats them (audit QOL-3). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Room } from '../server/game/Room.ts';

function lockedRoom(t) {
  const room = new Room();
  t.after(() => { room.engine.reset(); for (const timer of room.removalTimers.values()) clearTimeout(timer); });
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const seated = room.join('Seated').participant;
  room.attach(seated.id, 'seated');
  room.updateSettings(host.id, { lockRoom: true });
  return { room, host, seated };
}

test('a newcomer to a locked room watches and is not auto-seated when a slot frees', (t) => {
  const { room, seated } = lockedRoom(t);
  const late = room.join('Late').participant;
  room.attach(late.id, 'late');
  assert.equal(late.role, 'spectator');
  assert.equal(late.autoSpectator, false);
  room.remove(seated.id); // a player leaves in the lobby
  assert.equal(room.participants.get(late.id).role, 'spectator');
});

test('the host can still seat anyone; a spectator cannot seat themselves while locked', (t) => {
  const { room, host } = lockedRoom(t);
  const late = room.join('Late').participant;
  room.attach(late.id, 'late');
  assert.ok(room.hasFreePlayerSlot());
  assert.throws(() => room.setRole(late.id, late.id, 'player'), /The room is locked/);
  room.setRole(host.id, late.id, 'player');
  assert.equal(late.role, 'player');
});

test('TV views and session resume are unaffected', (t) => {
  const { room, seated } = lockedRoom(t);
  const tv = room.join('TV', true).participant;
  assert.equal(tv.role, 'spectator');
  assert.equal(tv.displayOnly, true);
  assert.equal(room.resume(seated.token)?.id, seated.id);
  assert.equal(room.participants.get(seated.id).role, 'player');
});

test('unlocking does not seat waiting spectators by itself', (t) => {
  const { room, host, seated } = lockedRoom(t);
  const late = room.join('Late').participant;
  room.attach(late.id, 'late');
  room.updateSettings(host.id, { lockRoom: false });
  room.remove(seated.id);
  assert.equal(room.participants.get(late.id).role, 'spectator');
  room.setRole(late.id, late.id, 'player'); // once unlocked, a spectator may take a free seat again
  assert.equal(late.role, 'player');
});

test('locking freezes seating, also for spectators who were waiting before the lock', (t) => {
  const room = new Room();
  t.after(() => { room.engine.reset(); for (const timer of room.removalTimers.values()) clearTimeout(timer); });
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  room.updateSettings(host.id, { maxPlayers: 2 });
  const a = room.join('A').participant; room.attach(a.id, 'a');
  const b = room.join('B').participant; room.attach(b.id, 'b');
  const waiting = room.join('Waiting').participant; room.attach(waiting.id, 'w');
  assert.equal(waiting.autoSpectator, true); // the table was full before the lock
  room.updateSettings(host.id, { lockRoom: true });
  room.remove(a.id);
  assert.equal(room.participants.get(waiting.id).role, 'spectator');
});

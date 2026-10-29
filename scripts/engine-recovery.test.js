/** Active game seats must not leave stale chooser or auction assignments. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-engine-recovery-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.js');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.js'), import('../server/packs/packManager.js'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function game(t) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const players = ['Alice', 'Bob', 'Carol'].map((name, i) => {
    const p = room.join(name).participant;
    room.attach(p.id, `player-${i}`);
    return p;
  });
  room.setPack({ ...loaded, pack: structuredClone(loaded.pack) });
  room.updateSettings(host.id, { gameMode: 'classic' });
  room.engine.start();
  players.forEach((p) => { p.score = 600; });
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, players };
}

test('a removed answerer does not become the next chooser', (t) => {
  const { room, host, players: [alice, bob] } = game(t);
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);
  assert.equal(engine.phase, 'answering');
  room.remove(alice.id);
  engine.judge(true);
  engine.next();
  assert.equal(engine.chooserId, bob.id);
  engine.selectQuestion(bob.id, false, 0, 1);
  assert.equal(engine.phase, 'reading');
});

test('a reseated stake bidder cannot keep the turn or win the question', (t) => {
  const { room, host, players: [alice, bob, carol] } = game(t);
  const engine = room.engine;
  engine.chooserId = alice.id;
  engine.selectQuestion(host.id, true, 0, 4);
  engine.bidStake(alice.id, 500);
  assert.equal(engine.auctionTurnId(), bob.id);
  room.setRole(host.id, bob.id, 'spectator');
  assert.equal(engine.auctionTurnId(), carol.id);
  room.setRole(host.id, alice.id, 'spectator');
  engine.passStake(carol.id);
  assert.equal(engine.phase, 'reveal');
  assert.equal(engine.current.assignedId, null);
});

test('removing the current stake bidder advances immediately', (t) => {
  const { room, host, players: [alice, bob, carol] } = game(t);
  const engine = room.engine;
  engine.chooserId = alice.id;
  engine.selectQuestion(host.id, true, 0, 4);
  assert.equal(engine.auctionTurnId(), alice.id);
  room.remove(alice.id);
  assert.equal(engine.auctionTurnId(), bob.id);
  engine.passStake(bob.id);
  engine.passStake(carol.id);
  assert.equal(engine.phase, 'reveal');
});

test('a queued press before the buzzer deadline is accepted when its random window ends later', async (t) => {
  const { room, host, players: [alice] } = game(t);
  room.updateSettings(host.id, {
    buttonPressMode: 'randomWithinInterval',
    buttonPressIntervalMs: 1000,
    timeForThinkingOnQuestion: 1,
  });
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  assert.equal(engine.buzz(alice.id).result, 'queued');
  await delay(1100);
  assert.equal(engine.phase, 'answering');
  assert.equal(engine.buzzer.winnerId, alice.id);
  assert.equal(engine.buzzer.remainingMs, 1000);
});

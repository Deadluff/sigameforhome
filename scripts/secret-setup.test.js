/**
 * Secret question setup: the countdown everyone sees must lead somewhere.
 * Playtest: the host missed the setup form, the clock reached zero and the table stayed blank.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-secret-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');

// Config reads environment variables when imported, so create the fixture first.
await import('./make-sample-pack.ts');
const [{ Room }, { listPacks, loadPack }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
]);
const file = (await listPacks()).find((pack) => pack.name.includes('v5')).file;
const loaded = await loadPack(file);
// In the v5 fixture, question 2 of each theme is a secret (100–500), question 3 a 400-point gift.
const SECRET = 2;
const GIFT = 3;
const SETUP_SECONDS = 9;

after(async () => rm(root, { recursive: true, force: true }));

function createRoom(t, modifyPack = () => {}) {
  // Mocked before any engine timer starts, so the setup countdown can be run out at once.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const players = ['Ann', 'Ben'].map((name) => {
    const player = room.join(name).participant;
    room.attach(player.id, `${name}-socket`);
    return player;
  });
  const pack = structuredClone(loaded.pack);
  modifyPack(pack);
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, {
    ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0,
    timeForGivingACat: SETUP_SECONDS,
  });
  room.engine.start();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, players };
}

test('an unassigned secret goes to a player at its lowest value when the countdown ends', (t) => {
  const { room, host, players } = createRoom(t);
  room.engine.selectQuestion(host.id, true, 0, SECRET);
  assert.equal(room.engine.phase, 'specialSetup');
  t.mock.timers.tick(SETUP_SECONDS * 1000);
  assert.equal(room.engine.phase, 'reading');
  const current = room.engine.current;
  assert.ok(players.some((p) => p.id === current.assignedId), 'a seated player gets the question');
  assert.equal(current.price, 100);
  // The recipient answers and is judged as if the host had chosen them.
  room.engine.openBuzzer();
  assert.equal(room.engine.buzzer.winnerId, current.assignedId);
  room.engine.judge(true);
  assert.equal(room.participants.get(current.assignedId).score, 100);
});

test('the countdown still ends the setup after a pause', (t) => {
  const { room, host } = createRoom(t);
  room.engine.selectQuestion(host.id, true, 0, SECRET);
  t.mock.timers.tick(4000);
  room.engine.pause();
  room.engine.resume();
  t.mock.timers.tick(SETUP_SECONDS * 1000);
  assert.equal(room.engine.phase, 'reading');
  assert.ok(room.engine.current.assignedId);
});

test('a timed-out "except current" secret never returns to the player who opened it', (t) => {
  const { room, host, players } = createRoom(t, (pack) => {
    pack.rounds[0].themes[0].questions[SECRET].typeParams.selectionMode = 'exceptCurrent';
  });
  room.engine.chooserId = players[0].id;
  room.engine.selectQuestion(host.id, true, 0, SECRET);
  t.mock.timers.tick(SETUP_SECONDS * 1000);
  assert.equal(room.engine.current.assignedId, players[1].id);
});

test('with nobody eligible the setup waits for the host instead', (t) => {
  const { room, host, players } = createRoom(t);
  for (const player of players) room.detach(player.id, `${player.name}-socket`);
  room.engine.selectQuestion(host.id, true, 0, SECRET);
  t.mock.timers.tick(SETUP_SECONDS * 1000);
  assert.equal(room.engine.phase, 'specialSetup');
});

test('a timed-out gift awards its fixed value', (t) => {
  const { room, host, players } = createRoom(t);
  room.engine.selectQuestion(host.id, true, 0, GIFT);
  t.mock.timers.tick(SETUP_SECONDS * 1000);
  assert.equal(room.engine.phase, 'reveal');
  const winner = players.find((p) => p.id === room.engine.current.assignedId);
  assert.equal(winner?.score, 400);
});

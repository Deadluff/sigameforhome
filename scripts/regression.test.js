/** Security and recovery cases that the browser smoke test cannot cover quickly. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-regression-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');

// Config reads environment variables when imported, so create the fixture first.
await import('./make-sample-pack.js');
const [{ Room }, { listPacks, loadPack }, { persistRoom, restoreRoom }] = await Promise.all([
  import('../server/game/Room.js'),
  import('../server/packs/packManager.js'),
  import('../server/game/persistence.js'),
]);
const file = (await listPacks()).find((pack) => pack.name.includes('v5')).file;
const loaded = await loadPack(file);

after(async () => rm(root, { recursive: true, force: true }));

function createRoom(t, gameMode = 'simple', modifyPack = () => {}) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player-socket');
  const spectator = room.join('Spectator').participant;
  room.attach(spectator.id, 'spectator-socket');
  room.setRole(spectator.id, spectator.id, 'spectator');
  // Each test may alter question content or type; keep the shared parsed fixture intact.
  const pack = structuredClone(loaded.pack);
  modifyPack(pack);
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { gameMode });
  room.engine.start();
  // Engine timers keep Node alive after an assertion unless explicitly cleared.
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, player, spectator };
}

test('answer data and media stay private until reveal', (t) => {
  const { room, host, player, spectator } = createRoom(t);
  room.engine.selectQuestion(host.id, true, 0, 1);
  const question = room.engine.current.question;
  const image = question.content.find((item) => item.type === 'image');
  assert.ok(image?.url, 'sample question has an image');
  const answerMedia = { type: 'image', url: `/media/${loaded.packId}/Images/private-answer.png` };
  question.answerContent.push(answerMedia);

  assert.equal(room.snapshotFor(player.id).game.current.right, null);
  assert.equal(room.snapshotFor(player.id).game.current.answerContent, null);
  assert.ok(room.snapshotFor(host.id).game.current.right?.length);
  assert.equal(room.canAccessMedia('', image.url), false);
  assert.equal(room.canAccessMedia('invalid-ticket', image.url), false);
  assert.equal(room.canAccessMedia(player.mediaTicket, image.url), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, answerMedia.url), false);
  assert.equal(room.canAccessMedia(spectator.mediaTicket, answerMedia.url), false);
  assert.equal(room.canAccessMedia(host.mediaTicket, answerMedia.url), true);

  room.engine.revealAnswer();
  assert.ok(room.snapshotFor(player.id).game.current.right?.length);
  assert.equal(room.canAccessMedia(player.mediaTicket, answerMedia.url), true);
});

test('connected player recovers moderation after host grace expires', (t) => {
  const { room, host, player, spectator } = createRoom(t);
  room.detach(host.id, 'host-socket');
  clearTimeout(room.removalTimers.get(host.id));
  room.expire(host.id);

  assert.equal(room.ownerId, player.id);
  assert.equal(room.participants.get(host.id).role, 'host');
  assert.equal(room.canModerate(player.id), true);
  room.setRole(player.id, host.id, 'spectator');
  room.setRole(player.id, spectator.id, 'host');
  assert.equal(room.canModerate(spectator.id), true);
  assert.equal(room.canModerate(player.id), false);
});

test('display-only TV never inherits a freed player seat', (t) => {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.join('Second player');
  const tv = room.join('TV', true).participant;
  room.updateSettings(host.id, { maxPlayers: 2 });
  room.remove(player.id);
  assert.equal(tv.role, 'spectator');
  assert.equal(tv.displayOnly, true);
  assert.equal(room.players().length, 1);
  t.after(() => room.engine.reset());
});

test('guided secret questions assign one player and use the chosen value', (t) => {
  const { room, host, player } = createRoom(t, 'classic');
  room.engine.selectQuestion(host.id, true, 0, 2);
  assert.equal(room.engine.phase, 'specialSetup');
  assert.deepEqual(room.snapshotFor(player.id).game.current.content, []);
  room.engine.configureSpecial(player.id, 200);
  assert.equal(room.engine.phase, 'reading');
  assert.equal(room.engine.buzz(player.id).result, 'ignored');
  room.engine.openBuzzer();
  assert.equal(room.engine.buzzer.winnerId, player.id);
  room.engine.judge(false);
  assert.equal(player.score, -200);
});

test('no-risk question never subtracts points for a wrong answer', (t) => {
  const { room, host, player } = createRoom(t, 'classic', (pack) => {
    pack.rounds[0].themes[0].questions[0].type = 'noRisk';
  });
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openBuzzer();
  assert.equal(room.engine.buzz(player.id).result, 'accepted');
  room.engine.judge(false);
  assert.equal(player.score, 0);
});

test('secret without a question awards fixed points without exposing content', (t) => {
  const { room, host, player } = createRoom(t, 'classic');
  room.engine.selectQuestion(host.id, true, 0, 3);
  assert.equal(room.engine.phase, 'specialSetup');
  const hiddenMedia = { type: 'image', url: `/media/${loaded.packId}/Images/hidden-gift.png` };
  room.engine.current.question.content.push(hiddenMedia);
  assert.deepEqual(room.snapshotFor(player.id).game.current.content, []);
  assert.throws(() => room.engine.configureSpecial(player.id, 401), /Value must be/);
  room.engine.configureSpecial(player.id, 400);
  assert.equal(room.engine.phase, 'reveal');
  assert.equal(player.score, 400);
  assert.equal(room.snapshotFor(player.id).game.current.assignedId, player.id);
  assert.deepEqual(room.snapshotFor(player.id).game.current.content, []);
  assert.equal(room.snapshotFor(host.id).game.current.right, null);
  assert.equal(room.canAccessMedia(player.mediaTicket, hiddenMedia.url), false);
  room.engine.next();
  assert.equal(room.engine.phase, 'board');
});

test('final wagers stay private and scoring follows each wager', (t) => {
  const { room, host, player } = createRoom(t, 'classic');
  room.adjustScore(host.id, player.id, 500);
  room.engine.enterRound(2);
  room.engine.selectQuestion(host.id, true, 0, 0);
  assert.equal(room.engine.phase, 'finalWager');
  assert.deepEqual(room.snapshotFor(player.id).game.current.content, []);
  assert.throws(() => room.engine.openFinal(), /every connected player/);

  room.engine.setFinalWager(player.id, 300);
  assert.equal(room.snapshotFor(player.id).game.final.yourWager, 300);
  assert.equal(room.snapshotFor(player.id).game.final.wagers, null);
  assert.equal(room.snapshotFor(host.id).game.final.wagers, null);
  room.engine.openFinal();
  assert.equal(room.snapshotFor(player.id).game.current.right, null);
  room.engine.closeFinal();
  assert.deepEqual(room.snapshotFor(host.id).game.final.wagers, { [player.id]: 300 });
  room.engine.judgeFinal(player.id, true);
  assert.equal(player.score, 800);
  assert.ok(room.snapshotFor(player.id).game.current.right?.length);
});

test('restart preserves seats and replays an interrupted question', async (t) => {
  const { room, host, player } = createRoom(t);
  const flush = persistRoom(room);
  room.engine.selectQuestion(host.id, true, 0, 1);
  room.changed();
  // Shutdown must save even when the normal 250 ms debounce has not fired.
  await flush();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 1), true);
  assert.equal(restored.participants.get(player.id).connected, false);
  assert.equal(restored.participants.get(host.id).role, 'host');
  restored.attach(player.id, 'reconnected-player');
  assert.equal(restored.ownerId, player.id);
  assert.equal(restored.canModerate(player.id), true);
});

test('restart rolls back partial scoring before replaying a question', async (t) => {
  const { room, host, player } = createRoom(t);
  const second = room.join('Second player').participant;
  room.attach(second.id, 'second-player');
  const stateFile = path.join(root, 'partial-score-state.json');
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openBuzzer();
  room.engine.buzz(player.id);
  room.engine.judge(false);
  assert.equal(room.engine.phase, 'buzzerOpen');
  assert.ok(player.score < 0);
  await persistRoom(room, stateFile)();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 0), true);
  assert.equal(restored.participants.get(player.id).score, 0);
});

test('restart during an appeal vote replays the question without its old penalty', async (t) => {
  const { room, host, player } = createRoom(t);
  const second = room.join('Second player').participant;
  room.attach(second.id, 'second-player');
  const stateFile = path.join(root, 'appeal-state.json');
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openBuzzer();
  room.engine.buzz(player.id);
  room.engine.judge(false);
  room.engine.revealAnswer();
  room.engine.requestAppeal(player.id, 1);
  assert.equal(room.engine.phase, 'appealVote');
  await persistRoom(room, stateFile)();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 0), true);
  assert.equal(restored.participants.get(player.id).score, 0);
});

test('restart preserves seats and scores when the selected pack is missing', async (t) => {
  const { room, host, player } = createRoom(t);
  const stateFile = path.join(root, 'missing-pack-state.json');
  room.adjustScore(host.id, player.id, 300);
  await persistRoom(room, stateFile)();
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  saved.packFile = 'removed-pack.siq';
  await writeFile(stateFile, JSON.stringify(saved));

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.loadedPack, null);
  assert.equal(restored.engine.phase, 'lobby');
  assert.equal(restored.participants.get(player.id).score, 300);
  assert.equal(restored.participants.get(host.id).role, 'host');
  restored.attach(player.id, 'reconnected-player');
  assert.equal(restored.canModerate(player.id), true);
});

test('restart replays an interrupted stake auction from the board', async (t) => {
  const { room, host } = createRoom(t, 'classic');
  const stateFile = path.join(root, 'auction-state.json');
  const flush = persistRoom(room, stateFile);
  room.engine.selectQuestion(host.id, true, 0, 4);
  assert.equal(room.engine.phase, 'stakeAuction');
  room.engine.pause();
  await flush();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 4), true);
});

test('restart replays an interrupted for-all answer session from the board', async (t) => {
  const { room, host } = createRoom(t, 'classic', (pack) => {
    pack.rounds[0].themes[0].questions[0].type = 'forAll';
  });
  const stateFile = path.join(root, 'for-all-state.json');
  const flush = persistRoom(room, stateFile);
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openForAllAnswers();
  assert.equal(room.engine.phase, 'forAllAnswering');
  await flush();

  const restored = new Room();
  t.after(() => restored.engine.reset());
  await restoreRoom(restored, stateFile);
  assert.equal(restored.engine.phase, 'board');
  assert.equal(restored.engine.isAvailable(0, 0), true);
});

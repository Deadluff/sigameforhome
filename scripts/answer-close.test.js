/** Every answer closes on its own: an answer clip when the host's device reports its end, the rest on a clock. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-answer-close-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.ROOM_STATE_FILE = path.join(root, 'room-state.json');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

const SONG = { type: 'audio', value: 'song.mp3', url: '/media/song.mp3', placement: 'background', waitForFinish: true };

/** Theme 0 question 0 is a plain question; `answer` replaces what its reveal shows. */
function revealed(t, answer = {}) {
  const pack = structuredClone(loaded.pack);
  Object.assign(pack.rounds[0].themes[0].questions[0], answer);
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const alice = room.join('Alice').participant;
  room.attach(alice.id, 'alice-socket');
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  const engine = room.engine;
  engine.start();
  t.after(() => {
    engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  engine.selectQuestion(null, true, 0, 0);
  if (engine.phase === 'intro') {
    clearTimeout(engine.timer?.handle);
    engine.beginQuestion();
  }
  engine.revealAnswer();
  assert.equal(engine.phase, 'reveal');
  return engine;
}

test('an answer clip holds the question until the host device reports its end', (t) => {
  const engine = revealed(t, { answerContent: [SONG] });
  assert.equal(engine.timer, null, 'no clock cuts the song short');
  const id = engine.current.presentationId;
  // A late report about the question's own clip must not close the answer.
  assert.deepEqual(engine.contentFinished(id), { advanced: false });
  assert.deepEqual(engine.answerFinished('stale'), { advanced: false });
  assert.equal(engine.phase, 'reveal');
  assert.deepEqual(engine.answerFinished(id), { advanced: true });
  assert.equal(engine.phase, 'board');
});

test('an answer without a clip closes on the reveal clock, even after the host revealed it', (t) => {
  const engine = revealed(t, { answerContent: [] });
  assert.equal(engine.timer?.name, 'reveal');
  assert.deepEqual(engine.answerFinished(engine.current.presentationId), { advanced: false });
});

test('a point answer shows on the picture, so its clips do not hold the question', (t) => {
  const engine = revealed(t, { answerType: 'point', right: ['0.5,0.5'], answerContent: [SONG] });
  assert.equal(engine.timer?.name, 'reveal');
});

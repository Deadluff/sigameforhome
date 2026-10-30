/** A restart between final themes must keep completed themes and continue the round. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import AdmZip from 'adm-zip';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-final-restart-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
const [{ Room }, { loadPack }, { persistRoom, restoreRoom }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
  import('../server/game/persistence.ts'),
]);
after(async () => fsp.rm(root, { recursive: true, force: true }));

test('restart after a final reveal continues through unplayed themes', async (t) => {
  await fsp.mkdir(process.env.PACKS_DIR, { recursive: true });
  const file = 'Multiple finals.siq';
  const themes = ['A', 'B', 'C'].map((name) =>
    `<theme name="${name}"><questions><question price="0"><params><param name="question" type="content"><item>Question ${name}</item></param></params><right><answer>${name}</answer></right></question></questions></theme>`).join('');
  const xml = `<package name="Multiple finals" version="5"><rounds><round name="Final" type="final"><themes>${themes}</themes></round></rounds></package>`;
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from(xml));
  zip.writeZip(path.join(process.env.PACKS_DIR, file));

  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player');
  room.setPack(await loadPack(file));
  room.updateSettings(host.id, { gameMode: 'classic', playAllQuestionsInFinalRound: true });
  room.engine.start();
  t.after(() => room.engine.reset());

  // Only players with a positive score play the final.
  player.score = 100;
  const reveal = (themeIndex) => {
    // The last remaining theme starts on its own; earlier ones are picked from the board.
    if (room.engine.phase === 'board') room.engine.selectQuestion(host.id, true, themeIndex, 0);
    assert.equal(room.engine.current.themeIndex, themeIndex);
    room.engine.setFinalWager(player.id, 0);
    room.engine.openFinal();
    room.engine.closeFinal();
    room.engine.judgeFinal(player.id, true);
    assert.equal(room.engine.phase, 'reveal');
  };

  room.engine.removeFinalTheme(host.id, true, 0);
  room.engine.removeFinalTheme(host.id, true, 1);
  reveal(2);
  const state1 = path.join(root, 'first-reveal.json');
  await persistRoom(room, state1)();
  const restored1 = new Room();
  t.after(() => restored1.engine.reset());
  await restoreRoom(restored1, state1);
  assert.equal(restored1.engine.phase, 'finalThemes');
  assert.deepEqual(restored1.engine.finalThemeIndices(), [0, 1]);
  assert.deepEqual([...restored1.engine.removedFinalThemes], []);

  room.engine.next();
  room.engine.removeFinalTheme(host.id, true, 0);
  reveal(1);
  const state2 = path.join(root, 'second-reveal.json');
  await persistRoom(room, state2)();
  const restored2 = new Room();
  t.after(() => restored2.engine.reset());
  await restoreRoom(restored2, state2);
  assert.equal(restored2.engine.phase, 'board');
  assert.deepEqual(restored2.engine.finalThemeIndices(), [0]);
  assert.equal(restored2.engine.isAvailable(0, 0), true);
});

/** Focused media gate and codec-probe regressions. Run with node --test scripts/media.test.js. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Room } from '../server/game/Room.ts';
import { ensureIosCompatibleMedia, needsIosVideoTranscode } from '../server/packs/mediaTranscoder.ts';

test('codec tags split across read chunks are still detected', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-media-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  const data = Buffer.alloc(64 * 1024 + 8);
  data.write('avc1', 0, 'latin1');
  data.write('av01', 64 * 1024 - 2, 'latin1');
  await fsp.writeFile(file, data);
  assert.equal(await needsIosVideoTranscode(file), true);

  data.fill(0, 64 * 1024 - 2, 64 * 1024 + 2);
  await fsp.writeFile(file, data);
  assert.equal(await needsIosVideoTranscode(file), false);

  const forgedAdjacent = `${file}.ios.mp4`;
  await fsp.writeFile(forgedAdjacent, 'pack-authored collision');
  const derivative = path.join(dir, '_derived', 'clip.mp4.ios.mp4');
  await fsp.mkdir(path.dirname(derivative), { recursive: true });
  await fsp.writeFile(derivative, 'already converted');
  assert.equal(await ensureIosCompatibleMedia(file, dir), derivative);
});

test('media tickets authorize only visible items and their matching derivatives', () => {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player-socket');

  const image = '/media/pack/Images/visible.jpg';
  const answer = `${image}.ios.mp4`;
  const video = '/media/pack/Video/clip.webm';
  const audio = '/media/pack/Audio/clip.ogg';
  room.loadedPack = { pack: { logo: null } };
  room.engine.current = {
    type: 'simple',
    answerShown: false,
    question: {
      content: [
        { type: 'image', url: image },
        { type: 'video', url: video },
        { type: 'audio', url: audio },
      ],
      answerContent: [{ type: 'image', url: answer }],
    },
  };
  room.engine.phase = 'reading';

  assert.equal(room.canAccessMedia(player.mediaTicket, image), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, answer), false);
  assert.equal(room.canAccessMedia(host.mediaTicket, answer), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, `${video}.ios.mp4`), false);
  assert.equal(room.canAccessMedia(player.mediaTicket, '/media/pack/_derived/Video/clip.webm.ios.mp4'), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, '/media/pack/_derived/Audio/clip.ogg.ios.mp3'), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, `${video}.ios.mp3`), false);
  assert.equal(room.canAccessMedia('', video), false);

  const oldHostTicket = host.mediaTicket;
  room.detach(host.id, 'host-socket');
  assert.equal(room.canAccessMedia(oldHostTicket, answer), false);
  room.attach(host.id, 'host-reconnected');
  assert.notEqual(host.mediaTicket, oldHostTicket);
  assert.equal(room.canAccessMedia(oldHostTicket, answer), false);
  assert.equal(room.canAccessMedia(host.mediaTicket, answer), true);

  room.engine.phase = 'stakeAuction';
  assert.equal(room.canAccessMedia(player.mediaTicket, video), false);
  room.engine.phase = 'paused';
  room.engine.paused = { phase: 'stakeAuction' };
  assert.equal(room.canAccessMedia(player.mediaTicket, video), false);
  room.remove(player.id);
  assert.equal(room.canAccessMedia(player.mediaTicket, video), false);
  room.engine.reset();
});

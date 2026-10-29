/** Browser pack uploads are bounded, private to managers, and never replace a pack. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { Room } from '../server/game/Room.ts';
import { canUpload, MAX_UPLOAD_BYTES, saveUploadedPack, UploadError, uploadFileStem } from '../server/packs/upload.ts';

function fixture() {
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from(
    '<package name="Uploaded pack" version="5"><rounds><round name="Round"><themes><theme name="Theme"><questions><question price="100"><params><param name="question" type="content"><item>Q?</item></param></params><right><answer>A</answer></right></question></questions></theme></themes></round></rounds></package>',
  ));
  return zip.toBuffer();
}

test('only a connected manager with a valid room token can upload', () => {
  const room = new Room();
  const { participant: host, token: hostToken } = room.join('Host');
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const { participant: player, token: playerToken } = room.join('Player');
  room.attach(player.id, 'player');
  const { participant: tv, token: tvToken } = room.join('TV', true);
  room.attach(tv.id, 'tv');
  assert.equal(canUpload(room, `Bearer ${hostToken}`), true);
  assert.equal(canUpload(room, `Bearer ${playerToken}`), false);
  assert.equal(canUpload(room, `Bearer ${tvToken}`), false);
  assert.equal(canUpload(room, 'Bearer invalid'), false);
  room.detach(host.id, 'host');
  assert.equal(canUpload(room, `Bearer ${hostToken}`), false);
  for (const timer of room.removalTimers.values()) clearTimeout(timer);
});

test('encoded Unicode names are safe and repeated uploads keep both files', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-upload-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const name = encodeURIComponent('Київські питання.siq');
  const first = await saveUploadedPack(Readable.from([fixture()]), name, dir);
  const second = await saveUploadedPack(Readable.from([fixture()]), name, dir);
  assert.equal(first.name, 'Uploaded pack');
  assert.notEqual(first.file, second.file);
  assert.match(first.file, /^Київські питання-[a-f0-9]{8}\.siq$/);
  assert.deepEqual((await fsp.readdir(dir)).sort(), [first.file, second.file].sort());
});

test('an upload revoked while streaming cannot publish a pack', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-upload-revoked-'));
  const room = new Room();
  const { participant: host, token } = room.join('Host');
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const authorization = `Bearer ${token}`;
  t.after(async () => {
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  let firstChunkSent;
  let continueUpload;
  const firstChunk = new Promise((resolve) => { firstChunkSent = resolve; });
  const released = new Promise((resolve) => { continueUpload = resolve; });
  const bytes = fixture();
  const source = Readable.from((async function* () {
    yield bytes.subarray(0, 10);
    firstChunkSent();
    await released;
    yield bytes.subarray(10);
  })());

  assert.equal(canUpload(room, authorization), true);
  const pending = saveUploadedPack(source, 'revoked.siq', dir, MAX_UPLOAD_BYTES,
    () => canUpload(room, authorization));
  await firstChunk;
  room.detach(host.id, 'host-socket');
  continueUpload();
  await assert.rejects(pending, (err) => err instanceof UploadError && err.status === 403);
  assert.deepEqual(await fsp.readdir(dir), []);
});

test('invalid names and archives fail without leaving partial files', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-upload-bad-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  assert.throws(() => uploadFileStem('..%2Fstolen.siq'), (err) => err instanceof UploadError && err.status === 400);
  assert.throws(() => uploadFileStem('%E0%A4%A'), (err) => err instanceof UploadError && err.status === 400);
  await assert.rejects(saveUploadedPack(Readable.from([Buffer.from('bad zip')]), 'bad.siq', dir),
    (err) => err instanceof UploadError && err.status === 422);
  const empty = new AdmZip();
  empty.addFile('content.xml', Buffer.from('<package name="Empty" version="5"><rounds /></package>'));
  await assert.rejects(saveUploadedPack(Readable.from([empty.toBuffer()]), 'empty.siq', dir),
    (err) => err instanceof UploadError && err.status === 422);
  const noQuestions = new AdmZip();
  noQuestions.addFile('content.xml', Buffer.from(
    '<package name="Empty round" version="5"><rounds><round name="Round"><themes /></round></rounds></package>',
  ));
  await assert.rejects(saveUploadedPack(Readable.from([noQuestions.toBuffer()]), 'empty-round.siq', dir),
    (err) => err instanceof UploadError && err.status === 422);
  await assert.rejects(saveUploadedPack(Readable.from([Buffer.alloc(9)]), 'large.siq', dir, 8),
    (err) => err instanceof UploadError && err.status === 413);
  assert.deepEqual(await fsp.readdir(dir), []);
});

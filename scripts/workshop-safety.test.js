/** Workshop updates must preserve a working pack when a download is invalid. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import AdmZip from 'adm-zip';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-workshop-safety-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
const [{ storeWorkshopPack, locatePack }, { redactSteamLog, createSteamLogForwarder }] = await Promise.all([
  import('../server/steam/workshop.ts'), import('../server/steam/steamcmd.ts'),
]);
after(async () => fsp.rm(root, { recursive: true, force: true }));
const minimalXml = '<package name="Updated" version="5"><rounds><round name="One"><themes><theme name="T"><questions><question price="100"><params><param name="question" type="content"><item>Q</item></param></params><right><answer>A</answer></right></question></questions></theme></themes></round></rounds></package>';

test('invalid and oversized Workshop updates leave the existing pack intact', async () => {
  await fsp.mkdir(process.env.PACKS_DIR, { recursive: true });
  const destination = path.join(process.env.PACKS_DIR, 'Workshop_123.siq');
  await fsp.writeFile(destination, 'previous working pack');
  const source = path.join(root, 'incoming.siq');
  await fsp.writeFile(source, 'invalid zip');

  await assert.rejects(storeWorkshopPack(source, 'Workshop_123.siq'));
  assert.equal(await fsp.readFile(destination, 'utf8'), 'previous working pack');

  const handle = await fsp.open(source, 'w');
  try { await handle.truncate(200 * 1024 * 1024 + 1); }
  finally { await handle.close(); }
  await assert.rejects(storeWorkshopPack(source, 'Workshop_123.siq'), /200 MB limit/);
  assert.equal(await fsp.readFile(destination, 'utf8'), 'previous working pack');
  assert.deepEqual((await fsp.readdir(process.env.PACKS_DIR)), ['Workshop_123.siq']);
});

test('validated Workshop update keeps the prior version and reuses identical bytes', async () => {
  await fsp.mkdir(process.env.PACKS_DIR, { recursive: true });
  const previous = path.join(process.env.PACKS_DIR, 'Workshop_456.siq');
  await fsp.writeFile(previous, 'previous working pack');
  const source = path.join(root, 'valid.siq');
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from(minimalXml));
  zip.writeZip(source);

  const destination = await storeWorkshopPack(source, 'Workshop_456.siq');
  assert.notEqual(destination, previous);
  assert.equal(await fsp.readFile(previous, 'utf8'), 'previous working pack');
  assert.deepEqual(await fsp.readFile(destination), await fsp.readFile(source));
  assert.equal(await storeWorkshopPack(source, 'Workshop_456.siq'), destination);
  const fresh = await storeWorkshopPack(source, 'Fresh_789.siq');
  assert.equal(path.basename(fresh), 'Fresh_789.siq');
  assert.equal(await storeWorkshopPack(source, 'Fresh_789.siq'), fresh);
  await assert.rejects(storeWorkshopPack(source, '../escape.siq'), /Invalid pack file name/);
});

test('Workshop locator skips a larger broken .siq when a valid pack exists', async () => {
  const folder = path.join(root, 'candidates');
  await fsp.mkdir(folder);
  const valid = path.join(folder, 'valid.siq');
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from(minimalXml));
  zip.writeZip(valid);
  await fsp.writeFile(path.join(folder, 'broken.siq'), Buffer.alloc(4096));
  assert.equal(await locatePack(folder, root), valid);
});

test('steamcmd progress redacts configured passwords', () => {
  assert.equal(redactSteamLog('login nick secret123 failed', 'secret123'), 'login nick [redacted] failed');
  assert.equal(redactSteamLog('ordinary progress', ''), 'ordinary progress');
  const lines = [];
  const forwarder = createSteamLogForwarder((line) => lines.push(line), 'secret123');
  forwarder.write('login nick sec');
  forwarder.write('ret123 failed\n');
  forwarder.write(`${'x'.repeat(5000)}secret123\n`);
  forwarder.write(`${'y'.repeat(5000)}secret123`);
  forwarder.finish();
  forwarder.write('safe progress\n');
  assert.deepEqual(lines, ['login nick [redacted] failed', 'safe progress']);
});

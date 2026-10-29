/** Workshop updates must preserve a working pack when a download is invalid. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import AdmZip from 'adm-zip';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-workshop-safety-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.TOOLS_DIR = path.join(root, 'tools');
const [{ storeWorkshopPack, locatePack, downloadWorkshopPack }, { redactSteamLog, createSteamLogForwarder, ensureSteamcmd, steamcmdDownloadItem }] = await Promise.all([
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

test('revoked Workshop publication leaves no new pack behind', async () => {
  const source = path.join(root, 'revoked.siq');
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from(minimalXml));
  zip.writeZip(source);
  await assert.rejects(storeWorkshopPack(source, 'Revoked_123.siq', () => false), /permission was lost/);
  assert.equal((await fsp.readdir(process.env.PACKS_DIR)).includes('Revoked_123.siq'), false);
});

test('Workshop jobs cap distinct IDs and keep each shared requester authorization', async () => {
  const originalFetch = globalThis.fetch;
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from(minimalXml));
  const bytes = zip.toBuffer();
  let releaseDetails;
  const detailGate = new Promise((resolve) => { releaseDetails = resolve; });
  globalThis.fetch = async (url, options) => {
    const address = String(url);
    if (address.includes('GetPublishedFileDetails')) {
      assert.equal(options.signal instanceof AbortSignal, true);
      await detailGate;
      const id = new URLSearchParams(options.body).get('publishedfileids[0]');
      return new Response(JSON.stringify({ response: { publishedfiledetails: [{
        result: 1, title: `Shared ${id}`, file_url: `https://steam.invalid/${id}.siq`,
        filename: `${id}.siq`, file_size: bytes.length, consumer_app_id: 3553500,
      }] } }), { headers: { 'content-type': 'application/json' } });
    }
    if (address.startsWith('https://steam.invalid/')) {
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }
    throw new Error(`Unexpected fetch: ${address}`);
  };
  try {
    const firstProgress = [];
    const secondProgress = [];
    const shared = downloadWorkshopPack('123456', (event) => firstProgress.push(event.stage), () => false);
    const alsoShared = downloadWorkshopPack('123456', (event) => secondProgress.push(event.stage), () => true);
    assert.strictEqual(alsoShared, shared);
    const revoked = downloadWorkshopPack('234567', () => {}, () => false);
    const revokedResult = assert.rejects(revoked, /permission was lost/);
    await assert.rejects(downloadWorkshopPack('345678'), /Too many Workshop downloads/);
    releaseDetails();
    const result = await shared;
    assert.equal(result.id, '123456');
    assert.equal(firstProgress.includes('done'), true);
    assert.equal(secondProgress.includes('done'), true);
    await revokedResult;
    assert.equal((await fsp.readdir(process.env.PACKS_DIR)).some((file) => file.endsWith('_234567.siq')), false);
    await assert.rejects(downloadWorkshopPack('345678', () => {}, () => false), /permission was lost/);
  } finally {
    releaseDetails();
    globalThis.fetch = originalFetch;
  }
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

test('macOS installs the Valve SteamCMD tarball as an executable', { skip: process.platform !== 'darwin' }, async () => {
  const source = path.join(root, 'steamcmd-source');
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, 'steamcmd.sh'), '#!/bin/sh\nexit 0\n');
  const archive = path.join(root, 'steamcmd-test.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', source, 'steamcmd.sh']);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /steamcmd_osx\.tar\.gz$/);
    return new Response(await fsp.readFile(archive));
  };
  try {
    const executable = await ensureSteamcmd();
    assert.equal(await fsp.readFile(executable, 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal((await fsp.stat(executable)).mode & 0o111, 0o111);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('macOS reports the current Workshop depot error from Steam user logs', { skip: process.platform !== 'darwin' }, async () => {
  const home = path.join(root, 'home');
  const logDir = path.join(home, 'Library/Application Support/Steam/logs');
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.writeFile(path.join(logDir, 'workshop_log.txt'), [
    'Download item 111 requested by app',
    'Missing decryption key',
    'Download item 3778183287 requested by app',
    'Update canceled: Missing decryption key',
  ].join('\n'));
  const executable = await ensureSteamcmd();
  await fsp.writeFile(executable, '#!/bin/sh\necho "ERROR! Download item 3778183287 failed (Failure)"\n');
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await assert.rejects(steamcmdDownloadItem(3553500, '3778183287'), /decryption key/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

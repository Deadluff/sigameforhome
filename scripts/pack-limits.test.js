/** Listing must enforce archive limits before expanding untrusted pack XML. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import AdmZip from 'adm-zip';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-pack-limits-'));
process.env.PACKS_DIR = root;
process.env.CACHE_DIR = path.join(root, 'cache');
const [{ readPackHeader, parseSiq }, { listPacks, loadPack }, { readPackHeaderAsync, parseSiqAsync, isSiqArchiveAsync }] = await Promise.all([
  import('../server/packs/siqParser.ts'), import('../server/packs/packManager.ts'),
  import('../server/packs/parseAsync.ts'),
]);
after(async () => fsp.rm(root, { recursive: true, force: true }));

test('pack listing rejects oversized content.xml before decompressing it', async () => {
  const file = path.join(root, 'large-xml.siq');
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.alloc(10 * 1024 * 1024 + 1, 65));
  zip.writeZip(file);

  assert.throws(() => readPackHeader(file), /content.xml exceeds 10 MB/);
  await assert.rejects(parseSiq(file), /content.xml exceeds 10 MB/);
  const [pack] = await listPacks();
  assert.match(pack.error, /content.xml exceeds 10 MB/);
});

test('pack listing skips archives above the compressed size limit', async () => {
  const file = path.join(root, 'large-file.siq');
  const handle = await fsp.open(file, 'w');
  try { await handle.truncate(200 * 1024 * 1024 + 1); }
  finally { await handle.close(); }

  const packs = await listPacks();
  const pack = packs.find((item) => item.file === 'large-file.siq');
  assert.match(pack.error, /200 MB limit/);
});

test('large pack parsing leaves the game timer event loop free', async () => {
  const file = path.join(root, 'slow-header.siq');
  const zip = new AdmZip();
  // A valid XML entry near the accepted limit used to delay buzzer timers by hundreds of milliseconds.
  zip.addFile('content.xml', Buffer.from(`<package name="Slow"><padding>${'x'.repeat(8_000_000)}</padding></package>`));
  zip.writeZip(file);

  for (const parse of [() => readPackHeaderAsync(file), () => parseSiqAsync(file)]) {
    let timerRan = false;
    const pending = parse().then(() => assert.equal(timerRan, true));
    setTimeout(() => { timerRan = true; }, 0);
    await pending;
  }
});

test('pack parsing rejects a media entry too large to expand into one buffer', async () => {
  const file = path.join(root, 'large-media.siq');
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from('<package name="Large media" version="5"/>'));
  zip.addFile('Images/huge.png', Buffer.from('small compressed payload'));
  const archive = zip.toBuffer();
  let patched = false;
  for (let offset = 0; offset < archive.length - 46; offset++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = archive.readUInt16LE(offset + 28);
    if (archive.toString('utf8', offset + 46, offset + 46 + nameLength) !== 'Images/huge.png') continue;
    // The parser must reject the declared expanded size before AdmZip allocates it.
    archive.writeUInt32LE(256 * 1024 * 1024 + 1, offset + 24);
    patched = true;
    break;
  }
  assert.equal(patched, true);
  await fsp.writeFile(file, archive);

  assert.match((await listPacks()).find((pack) => pack.file === 'large-media.siq')?.error,
    /media file exceeds 256 MB/);
  await assert.rejects(parseSiq(file), /media file exceeds 256 MB/);
  await assert.rejects(loadPack('large-media.siq'), /media file exceeds 256 MB/);
});

test('pack list and loader reject fractional or unsafe question prices', async () => {
  for (const [index, price] of ['100.5', '9007199254740992', '1000001'].entries()) {
    const fileName = `bad-price-${index}.siq`;
    const zip = new AdmZip();
    zip.addFile('content.xml', Buffer.from(
      `<package name="Bad price"><rounds><round name="R"><themes><theme name="T"><questions><question price="${price}"/></questions></theme></themes></round></rounds></package>`,
    ));
    zip.writeZip(path.join(root, fileName));
    assert.match((await listPacks()).find((pack) => pack.file === fileName)?.error, /Question price must be a whole number/);
    await assert.rejects(loadPack(fileName), /Question price must be a whole number/);
  }
  const rangeFile = 'bad-stake-range.siq';
  const rangeZip = new AdmZip();
  rangeZip.addFile('content.xml', Buffer.from(
    '<package name="Bad stake"><rounds><round name="R"><themes><theme name="T"><questions><question price="100"><params><param name="price" type="numberSet"><numberSet minimum="10.5" maximum="100" step="10"/></param></params></question></questions></theme></themes></round></rounds></package>',
  ));
  rangeZip.writeZip(path.join(root, rangeFile));
  assert.match((await listPacks()).find((pack) => pack.file === rangeFile)?.error, /Stake minimum must be a whole number/);
  await assert.rejects(loadPack(rangeFile), /Stake minimum must be a whole number/);
});

test('replacing same-size pack bytes with the same mtime does not reuse old media', async () => {
  const file = path.join(root, 'identity.siq');
  const stamp = new Date('2020-01-01T00:00:00Z');
  const makePack = (name, image) => {
    const zip = new AdmZip();
    zip.addFile('content.xml', Buffer.from(`<package name="${name}" version="5"/>`));
    zip.addFile('Images/q.png', Buffer.from(image));
    zip.writeZip(file);
  };

  makePack('FirstA', 'AAAA');
  await fsp.utimes(file, stamp, stamp);
  const firstSize = (await fsp.stat(file)).size;
  assert.equal((await listPacks()).find((pack) => pack.file === 'identity.siq')?.name, 'FirstA');
  const first = await loadPack('identity.siq');
  assert.equal(await fsp.readFile(path.join(root, 'cache', first.packId, 'Images', 'q.png'), 'utf8'), 'AAAA');

  await new Promise((resolve) => setTimeout(resolve, 10));
  makePack('Second', 'BBBB');
  await fsp.utimes(file, stamp, stamp);
  assert.equal((await fsp.stat(file)).size, firstSize);
  assert.equal((await listPacks()).find((pack) => pack.file === 'identity.siq')?.name, 'Second');
  const second = await loadPack('identity.siq');
  assert.notEqual(second.packId, first.packId);
  assert.equal(await fsp.readFile(path.join(root, 'cache', second.packId, 'Images', 'q.png'), 'utf8'), 'BBBB');
});

test('concurrent pack requests share work and a busy parse queue can recover', async () => {
  const file = path.join(root, 'shared.siq');
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from('<package name="Shared" version="5"/>'));
  zip.writeZip(file);

  const firstList = listPacks();
  assert.strictEqual(listPacks(), firstList);
  await firstList;

  const firstLoad = loadPack('shared.siq');
  assert.strictEqual(loadPack('shared.siq'), firstLoad);
  await firstLoad;

  const results = await Promise.allSettled(Array.from({ length: 18 }, () => isSiqArchiveAsync(file)));
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /parser is busy/);
  assert.equal(await isSiqArchiveAsync(file), true);

  // A folder larger than the pending queue must still produce a complete listing.
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    fsp.copyFile(file, path.join(root, `batch-${index}.siq`))));
  const packs = await listPacks();
  assert.equal(packs.filter((pack) => pack.file.startsWith('batch-') && pack.name === 'Shared').length, 20);
});

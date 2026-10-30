/** Zip entries that declare size 0 must never be inflated (audit SEC-1), and adm-zip 0.6.1 still round-trips. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import AdmZip from 'adm-zip';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-archive-guard-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ parseSiq, readPackHeader }, { listPacks }] = await Promise.all([
  import('../server/packs/siqParser.ts'), import('../server/packs/packManager.ts'),
]);
after(async () => fsp.rm(root, { recursive: true, force: true }));

const CONTENT = Buffer.from(`<package name="Guard" version="5"><rounds><round name="R"><themes><theme name="T">
  <questions><question price="100"><params><param name="question" type="content">
    <item type="image" isRef="True">bomb.bin</item></param></params>
    <right><answer>A</answer></right></question></questions></theme></themes></round></rounds></package>`);

/**
 * Rewrites an entry's declared uncompressed size to 0, as a crafted archive would.
 * Local header: size at offset 22, name length at 26, name at 30.
 * Central header: size at offset 24, name length at 28, name at 46.
 */
function zeroSizeEntry(buf, name) {
  const want = Buffer.from(name);
  let patched = 0;
  for (let i = 0; i < buf.length - 46; i++) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x04034b50) {
      const len = buf.readUInt16LE(i + 26);
      if (len === want.length && buf.subarray(i + 30, i + 30 + len).equals(want)) { buf.writeUInt32LE(0, i + 22); patched++; }
    } else if (sig === 0x02014b50) {
      const len = buf.readUInt16LE(i + 28);
      if (len === want.length && buf.subarray(i + 46, i + 46 + len).equals(want)) { buf.writeUInt32LE(0, i + 24); patched++; }
    }
  }
  assert.equal(patched, 2, `patched local and central headers for ${name}`);
  return buf;
}

async function writeArchive(fileName, entries, zeroed = []) {
  const zip = new AdmZip();
  for (const [name, data] of entries) zip.addFile(name, data);
  let buf = zip.toBuffer();
  for (const name of zeroed) buf = zeroSizeEntry(buf, name);
  const file = path.join(root, fileName);
  await fsp.writeFile(file, buf);
  return file;
}

test('a media entry that lies about size 0 is extracted empty instead of inflated', async () => {
  const bomb = Buffer.alloc(64 * 1024 * 1024); // 64 MiB of zeros compresses to a few KB
  const file = await writeArchive('bomb.siq', [['content.xml', CONTENT], ['Images/bomb.bin', bomb]], ['Images/bomb.bin']);
  const out = path.join(root, 'bomb-out');
  await parseSiq(file, { extractTo: out });
  const stat = await fsp.stat(path.join(out, 'Images', 'bomb.bin'));
  assert.equal(stat.size, 0);
});

test('a content.xml that declares size 0 is rejected by parse and listing', async () => {
  const file = await writeArchive('empty-xml.siq', [['content.xml', CONTENT]], ['content.xml']);
  await assert.rejects(parseSiq(file), /content.xml is empty/);
  assert.throws(() => readPackHeader(file), /content.xml is empty/);
});

test('a genuinely empty media file is still accepted', async () => {
  const file = await writeArchive('real-empty.siq', [['content.xml', CONTENT], ['Images/bomb.bin', Buffer.alloc(0)]]);
  const out = path.join(root, 'real-empty-out');
  const pack = await parseSiq(file, { extractTo: out });
  assert.equal(pack.name, 'Guard');
  assert.equal((await fsp.stat(path.join(out, 'Images', 'bomb.bin'))).size, 0);
});

test('demo packs still parse', async () => {
  const packs = (await listPacks()).filter((pack) => pack.name.includes('Demo') || pack.file.includes('Demo'));
  assert.equal(packs.length, 2);
  for (const pack of packs) {
    assert.equal(pack.error ?? null, null);
    await parseSiq(path.join(process.env.PACKS_DIR, pack.file));
  }
});

test('adm-zip extractAllTo and writeZip round-trip (Steam bootstrap and repack paths)', async () => {
  const source = new AdmZip();
  source.addFile('steamcmd/readme.txt', Buffer.from('hello'));
  source.addFile('steamcmd/bin/tool', Buffer.alloc(4096, 7));
  const zipPath = path.join(root, 'roundtrip.zip');
  source.writeZip(zipPath);

  const dest = path.join(root, 'roundtrip-out');
  new AdmZip(zipPath).extractAllTo(dest, true);
  assert.equal(await fsp.readFile(path.join(dest, 'steamcmd/readme.txt'), 'utf8'), 'hello');
  assert.deepEqual(await fsp.readFile(path.join(dest, 'steamcmd/bin/tool')), Buffer.alloc(4096, 7));

  // Repack a loose folder, as parseWorker does for Workshop items without a .siq.
  const repacked = new AdmZip();
  repacked.addLocalFolder(dest);
  const repackPath = path.join(root, 'repacked.zip');
  repacked.writeZip(repackPath);
  const names = new AdmZip(repackPath).getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names.filter((n) => !n.endsWith('/')), ['steamcmd/bin/tool', 'steamcmd/readme.txt']);
});

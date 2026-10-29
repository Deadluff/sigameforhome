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
const [{ readPackHeader, parseSiq }, { listPacks }] = await Promise.all([
  import('../server/packs/siqParser.js'), import('../server/packs/packManager.js'),
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

/** Wave 5 backlog: invite QR target (SEC-9), cache pruning (CONN-8), client clock window (SEC-4), pack outline (QOL-7). */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-backlog-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ pickInviteUrl }, { pruneCache, listPacks, loadPack }, { Room }, { readPackHeader }] = await Promise.all([
  import('../server/http/invite.ts'),
  import('../server/packs/packManager.ts'),
  import('../server/game/Room.ts'),
  import('../server/packs/siqParser.ts'),
]);
after(async () => fsp.rm(root, { recursive: true, force: true }));

test('the join QR only encodes this server', () => {
  const own = ['192.168.1.5:3000', 'localhost:3000'];
  const fallback = 'http://192.168.1.5:3000';
  assert.equal(pickInviteUrl('http://192.168.1.5:3000', own, fallback), 'http://192.168.1.5:3000');
  assert.equal(pickInviteUrl('http://192.168.1.5:3000/?tv', own, fallback), 'http://192.168.1.5:3000/?tv');
  assert.equal(pickInviteUrl('http://LOCALHOST:3000/', own, fallback), 'http://localhost:3000');
  assert.equal(pickInviteUrl('http://192.168.1.5/', ['192.168.1.5:80'], fallback), 'http://192.168.1.5', 'port 80');
  for (const bad of ['http://evil.example', 'http://192.168.1.5:4000', 'http://192.168.1.5:3000/x',
    'javascript:alert(1)', 'http://192.168.1.5:3000/?tv#x', `http://192.168.1.5:3000/?${'a'.repeat(300)}`, undefined]) {
    assert.equal(pickInviteUrl(bad, own, fallback), fallback, String(bad).slice(0, 40));
  }
});

test('startup pruning removes caches unused for 30 days, keeps recent, kept and foreign folders', async () => {
  const cache = process.env.CACHE_DIR;
  const make = async (name, ageDays, marker = true) => {
    const dir = path.join(cache, name);
    await fsp.mkdir(dir, { recursive: true });
    if (marker) {
      const file = path.join(dir, '.extracted');
      await fsp.writeFile(file, 'x');
      const when = new Date(Date.now() - ageDays * 86_400_000);
      await fsp.utimes(file, when, when);
    }
  };
  await make('old', 40);
  await make('fresh', 2);
  await make('kept', 40);
  await make('not-ours', 400, false);
  await pruneCache(['kept'], 30 * 86_400_000);
  assert.deepEqual((await fsp.readdir(cache)).sort(), ['fresh', 'kept', 'not-ours']);
});

test('loading a pack again refreshes its last-use time', async () => {
  const file = (await listPacks()).find((pack) => pack.name.includes('v5')).file;
  const { packId } = await loadPack(file);
  const marker = path.join(process.env.CACHE_DIR, packId, '.extracted');
  const old = new Date(Date.now() - 40 * 86_400_000);
  await fsp.utimes(marker, old, old);
  await loadPack(file);
  assert.ok(Date.now() - (await fsp.stat(marker)).mtimeMs < 60_000);
});

test('a player clock is trusted at most 500 ms back', () => {
  const room = new Room();
  const now = 1_000_000;
  room.engine.buzzer.openedAt = now - 10_000;
  assert.equal(room.engine.resolvePressTimestamp(now, now - 1500), now - 500);
  assert.equal(room.engine.resolvePressTimestamp(now, now - 200), now - 200);
  room.engine.buzzer.openedAt = now - 100;
  assert.equal(room.engine.resolvePressTimestamp(now, now - 1500), now - 100, 'never before the buzzer opened');
});

test('the pack list carries round and theme names for a preview', () => {
  const header = readPackHeader(path.join(process.env.PACKS_DIR, 'Demo pack (v5 format).siq'));
  assert.ok(header.outline.length >= 1);
  assert.ok(header.outline.every((round) => typeof round.name === 'string' && Array.isArray(round.themes)));
  assert.ok(header.outline[0].themes.length > 0);
});

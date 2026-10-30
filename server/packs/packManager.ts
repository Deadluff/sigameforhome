/**
 * Pack manager: lists .siq files in the packs folder, loads them (parse + media
 * extraction with an on-disk cache) and serves their media.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { ensureDir, pathExists, safeJoin } from '../utils/fsx.ts';
import { backgroundTranscodePackMedia } from './mediaTranscoder.ts';
import { collectHtmlAssets } from './htmlAssets.ts';
import { parseSiqAsync, readPackHeaderAsync } from './parseAsync.ts';
import { type Package, type PackHeader } from './siqParser.ts';

const MARKER = '.extracted';

export interface PackListItem extends PackHeader {
  file: string;
  size: number;
  modified: string;
}

export interface LoadedPack {
  packId: string;
  file: string;
  pack: Package;
  htmlAssets: Map<string, Set<string>>;
}

/** Header cache keyed by "file|mtime|size" so listing large folders stays fast. */
const headerCache = new Map<string, PackHeader>();
let pendingList: Promise<PackListItem[]> | null = null;
const pendingLoads = new Map<string, Promise<LoadedPack>>();

/** Validates a user-supplied pack file name (no traversal, must be .siq). */
function resolvePackFile(fileName: string): string {
  const base = path.basename(String(fileName ?? ''));
  if (!base || base !== fileName || !base.toLowerCase().endsWith('.siq')) {
    throw new Error('Invalid pack file name');
  }
  return safeJoin(config.packsDir, base);
}

/** Cache identity follows actual bytes, even when a replacement preserves size and mtime. */
async function computePackId(fileName: string, full: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(fileName).update('\0');
  for await (const chunk of fs.createReadStream(full)) hash.update(chunk);
  return hash.digest('hex').slice(0, 24);
}

async function listPacksOnce(): Promise<PackListItem[]> {
  await ensureDir(config.packsDir);
  const files = (await fsp.readdir(config.packsDir)).filter((f) => f.toLowerCase().endsWith('.siq'));

  const packs: PackListItem[] = [];
  // Small batches let large folders list without filling the bounded parse queue.
  for (let offset = 0; offset < files.length; offset += 4) {
    packs.push(...await Promise.all(files.slice(offset, offset + 4).map(async (file): Promise<PackListItem> => {
      const full = path.join(config.packsDir, file);
      const stat = await fsp.stat(full);
      // The listing endpoint must not parse a pack that loadPack would reject.
      if (stat.size > 200 * 1024 * 1024) {
        return { file, size: stat.size, modified: stat.mtime.toISOString(),
          name: file, rounds: null, error: 'Pack exceeds the 200 MB limit' };
      }
      const key = `${file}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.size}`;
      let header = headerCache.get(key);
      if (!header) {
        try {
          header = await readPackHeaderAsync(full);
        } catch (err) {
          header = { name: file, rounds: null, error: (err as Error).message };
        }
        // A failed worker or temporary read must be retried on the next listing.
        if (!header.error) headerCache.set(key, header);
      }
      return { file, size: stat.size, modified: stat.mtime.toISOString(), ...header };
    })));
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

export function listPacks(): Promise<PackListItem[]> {
  if (!pendingList) pendingList = listPacksOnce().finally(() => { pendingList = null; });
  return pendingList;
}

async function loadPackOnce(fileName: string): Promise<LoadedPack> {
  const full = resolvePackFile(fileName);
  const stat = await fsp.stat(full).catch(() => {
    throw new Error(`Pack not found: ${fileName}`);
  });
  if (stat.size > 200 * 1024 * 1024) throw new Error('Pack exceeds the 200 MB limit');

  const packId = await computePackId(fileName, full);
  const cacheDir = path.join(config.cacheDir, packId);
  const alreadyExtracted = await pathExists(path.join(cacheDir, MARKER));

  const pack = await parseSiqAsync(full, {
    mediaBaseUrl: `/media/${packId}`,
    extractTo: alreadyExtracted ? undefined : cacheDir,
  });
  if (!alreadyExtracted) await fsp.writeFile(path.join(cacheDir, MARKER), new Date().toISOString());
  // The marker's mtime records the last use, so startup pruning keeps packs played recently.
  else await fsp.utimes(path.join(cacheDir, MARKER), new Date(), new Date()).catch(() => {});
  const htmlAssets = await collectHtmlAssets(pack, cacheDir, packId);

  backgroundTranscodePackMedia(cacheDir).catch((err: Error) => {
    console.warn(`[media] background transcode warning: ${err.message}`);
  });

  return { packId, file: fileName, pack, htmlAssets };
}

export function loadPack(fileName: string): Promise<LoadedPack> {
  const pending = pendingLoads.get(fileName);
  if (pending) return pending;
  const load = loadPackOnce(fileName).finally(() => { pendingLoads.delete(fileName); });
  pendingLoads.set(fileName, load);
  return load;
}

/**
 * Removes extracted pack caches except `keepIds`. With `maxAgeMs`, only caches not used for that
 * long go (audit CONN-8: extracted media used to pile up without limit).
 */
export async function pruneCache(keepIds: string[] = [], maxAgeMs?: number): Promise<void> {
  if (!(await pathExists(config.cacheDir))) return;
  const now = Date.now();
  for (const dir of await fsp.readdir(config.cacheDir)) {
    if (keepIds.includes(dir)) continue;
    const full = path.join(config.cacheDir, dir);
    if (maxAgeMs !== undefined) {
      // Age pruning only touches folders this app extracted: CACHE_DIR may point somewhere shared.
      const used = await fsp.stat(path.join(full, MARKER)).catch(() => null);
      if (!used || now - used.mtimeMs < maxAgeMs) continue;
    }
    await fsp.rm(full, { recursive: true, force: true });
  }
}

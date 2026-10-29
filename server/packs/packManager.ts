/**
 * Pack manager: lists .siq files in the packs folder, loads them (parse + media
 * extraction with an on-disk cache) and serves their media.
 */
import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { ensureDir, pathExists, safeJoin } from '../utils/fsx.ts';
import { backgroundTranscodePackMedia } from './mediaTranscoder.ts';
import { type Package, type PackHeader, parseSiq, readPackHeader } from './siqParser.ts';

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
}

/** Header cache keyed by "file|mtime|size" so listing large folders stays fast. */
const headerCache = new Map<string, PackHeader>();

/** Validates a user-supplied pack file name (no traversal, must be .siq). */
function resolvePackFile(fileName: string): string {
  const base = path.basename(String(fileName ?? ''));
  if (!base || base !== fileName || !base.toLowerCase().endsWith('.siq')) {
    throw new Error('Invalid pack file name');
  }
  return safeJoin(config.packsDir, base);
}

/** Stable id derived from file identity: changes when the pack is replaced/updated. */
function computePackId(fileName: string, stat: Stats): string {
  return crypto.createHash('sha1').update(`${fileName}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 12);
}

export async function listPacks(): Promise<PackListItem[]> {
  await ensureDir(config.packsDir);
  const files = (await fsp.readdir(config.packsDir)).filter((f) => f.toLowerCase().endsWith('.siq'));

  const packs = await Promise.all(
    files.map(async (file): Promise<PackListItem> => {
      const full = path.join(config.packsDir, file);
      const stat = await fsp.stat(full);
      const key = `${file}|${stat.mtimeMs}|${stat.size}`;
      let header = headerCache.get(key);
      if (!header) {
        try {
          header = readPackHeader(full);
        } catch (err) {
          header = { name: file, rounds: null, error: (err as Error).message };
        }
        headerCache.set(key, header);
      }
      return { file, size: stat.size, modified: stat.mtime.toISOString(), ...header };
    }),
  );
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadPack(fileName: string): Promise<LoadedPack> {
  const full = resolvePackFile(fileName);
  const stat = await fsp.stat(full).catch(() => {
    throw new Error(`Pack not found: ${fileName}`);
  });

  const packId = computePackId(fileName, stat);
  const cacheDir = path.join(config.cacheDir, packId);
  const alreadyExtracted = await pathExists(path.join(cacheDir, MARKER));

  const pack = await parseSiq(full, {
    mediaBaseUrl: `/media/${packId}`,
    extractTo: alreadyExtracted ? undefined : cacheDir,
  });
  if (!alreadyExtracted) await fsp.writeFile(path.join(cacheDir, MARKER), new Date().toISOString());

  backgroundTranscodePackMedia(cacheDir).catch((err: Error) => {
    console.warn(`[media] background transcode warning: ${err.message}`);
  });

  return { packId, file: fileName, pack };
}

export async function pruneCache(keepIds: string[] = []): Promise<void> {
  if (!(await pathExists(config.cacheDir))) return;
  for (const dir of await fsp.readdir(config.cacheDir)) {
    if (!keepIds.includes(dir)) await fsp.rm(path.join(config.cacheDir, dir), { recursive: true, force: true });
  }
}

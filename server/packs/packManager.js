/**
 * Pack manager: lists .siq files in the packs folder, loads them (parse + media
 * extraction with an on-disk cache) and serves their media.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ensureDir, pathExists, safeJoin } from '../utils/fsx.js';
import { backgroundTranscodePackMedia } from './mediaTranscoder.js';
import { parseSiq, readPackHeader } from './siqParser.js';

const MARKER = '.extracted';

/** Header cache keyed by "file|mtime|size" so listing large folders stays fast. */
const headerCache = new Map();

/** Validates a user-supplied pack file name (no traversal, must be .siq). */
function resolvePackFile(fileName) {
  const base = path.basename(String(fileName ?? ''));
  if (!base || base !== fileName || !base.toLowerCase().endsWith('.siq')) {
    throw new Error('Invalid pack file name');
  }
  return safeJoin(config.packsDir, base);
}

/** Stable id derived from file identity: changes when the pack is replaced/updated. */
function computePackId(fileName, stat) {
  return crypto.createHash('sha1').update(`${fileName}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 12);
}

/**
 * @returns {Promise<{ file: string, size: number, modified: string, name: string, rounds: number|null, error?: string }[]>}
 */
export async function listPacks() {
  await ensureDir(config.packsDir);
  const files = (await fsp.readdir(config.packsDir)).filter((f) => f.toLowerCase().endsWith('.siq'));

  const packs = await Promise.all(
    files.map(async (file) => {
      const full = path.join(config.packsDir, file);
      const stat = await fsp.stat(full);
      const key = `${file}|${stat.mtimeMs}|${stat.size}`;
      let header = headerCache.get(key);
      if (!header) {
        try {
          header = readPackHeader(full);
        } catch (err) {
          header = { name: file, rounds: null, error: err.message };
        }
        headerCache.set(key, header);
      }
      return { file, size: stat.size, modified: stat.mtime.toISOString(), ...header };
    }),
  );
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parses a pack and makes sure its media is extracted to the cache.
 * @param {string} fileName file name inside the packs folder
 * @returns {Promise<{ packId: string, file: string, pack: import('./siqParser.js').Package }>}
 */
export async function loadPack(fileName) {
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

  // Warm up iOS/iPadOS video/audio transcodes in the background so AV1/VP9/Opus clips
  // are ready before or as soon as questions are opened.
  backgroundTranscodePackMedia(cacheDir).catch((err) => {
    console.warn(`[media] background transcode warning: ${err.message}`);
  });

  return { packId, file: fileName, pack };
}

/** Removes cached extractions except the ones in `keepIds` (called on startup). */
export async function pruneCache(keepIds = []) {
  if (!(await pathExists(config.cacheDir))) return;
  for (const dir of await fsp.readdir(config.cacheDir)) {
    if (!keepIds.includes(dir)) await fsp.rm(path.join(config.cacheDir, dir), { recursive: true, force: true });
  }
}

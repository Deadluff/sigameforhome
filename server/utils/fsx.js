/**
 * Small filesystem / HTTP helpers shared by the pack manager and Steam downloader.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Characters Windows refuses in file names, plus control chars. */
const INVALID_FS_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Turns arbitrary text (pack titles, zip entry names) into a safe single path segment. */
export function sanitizeSegment(name, fallback = '_') {
  let s = String(name ?? '').replace(INVALID_FS_CHARS, '_').trim();
  s = s.replace(/[. ]+$/, ''); // Windows strips trailing dots/spaces
  if (!s || s === '.' || s === '..') s = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`; // reserved device names
  return s.slice(0, 180);
}

/** Resolves `child` under `root` and throws if it escapes (zip-slip / path traversal guard). */
export function safeJoin(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes root: ${segments.join('/')}`);
  }
  return target;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively lists all files under `dir` (absolute paths). */
export async function walkFiles(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Streams a URL to disk via a temp file, reporting progress.
 * @param {string} url
 * @param {string} destination absolute file path
 * @param {(p: { received: number, total: number|null }) => void} [onProgress]
 */
export async function downloadToFile(url, destination, onProgress) {
  const maxBytes = 200 * 1024 * 1024;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} while downloading ${url}`);

  const total = Number(res.headers.get('content-length')) || null;
  if (total > maxBytes) throw new Error('Download exceeds the 200 MB limit');
  let received = 0;
  let lastReport = 0;

  const tmp = `${destination}.part`;
  await ensureDir(path.dirname(destination));

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (received > maxBytes) body.destroy(new Error('Download exceeds the 200 MB limit'));
    const now = Date.now();
    if (onProgress && now - lastReport > 250) {
      lastReport = now;
      onProgress({ received, total });
    }
  });

  try {
    await pipeline(body, fs.createWriteStream(tmp));
    await fsp.rename(tmp, destination);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  onProgress?.({ received, total });
  return destination;
}

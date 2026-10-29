/** Stream and validate a browser-uploaded SIQ without exposing partial packs in listings. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { ensureDir, sanitizeSegment } from '../utils/fsx.js';
import { parseSiq } from './siqParser.js';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** File names travel URI-encoded because HTTP request headers cannot carry arbitrary Unicode. */
export function uploadFileStem(encodedName) {
  if (typeof encodedName !== 'string' || !encodedName || encodedName.length > 720) {
    throw new UploadError(400, 'Choose a .siq file to upload');
  }
  let name;
  try { name = decodeURIComponent(encodedName); }
  catch { throw new UploadError(400, 'Invalid pack file name'); }
  if (name.includes('/') || name.includes('\\') || !name.toLowerCase().endsWith('.siq')) {
    throw new UploadError(400, 'Upload a .siq file with a plain file name');
  }
  const stem = sanitizeSegment(name.slice(0, -4), 'pack').slice(0, 130);
  if (!stem) throw new UploadError(400, 'Invalid pack file name');
  return stem;
}

/** The bearer token is the same secret used to resume a room seat. */
export function canUpload(room, authorization) {
  if (typeof authorization !== 'string') return false;
  const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)?.[1];
  const pid = token && room.tokens.get(token);
  return !!pid && !!room.participants.get(pid)?.connected && room.canManage(pid);
}

export async function saveUploadedPack(source, encodedName, packsDir = config.packsDir, maxBytes = MAX_UPLOAD_BYTES) {
  const stem = uploadFileStem(encodedName);
  await ensureDir(packsDir);
  const temp = path.join(packsDir, `.upload-${crypto.randomUUID()}.tmp`);
  let received = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > maxBytes
        ? new UploadError(413, 'Pack exceeds the 200 MB limit') : null, chunk);
    },
  });

  try {
    await pipeline(source, limit, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    let pack;
    try { pack = await parseSiq(temp); }
    catch (err) { throw new UploadError(422, `Invalid .siq pack: ${err.message}`); }
    if (!pack.rounds.length || !pack.stats.questions) {
      throw new UploadError(422, 'Pack has no playable questions');
    }

    // Hard-link publication fails if a destination exists and is atomic on the same volume.
    // Keeping the source .tmp until after publication prevents listing a partial .siq.
    for (let attempt = 0; attempt < 3; attempt++) {
      const file = `${stem}-${crypto.randomUUID().slice(0, 8)}.siq`;
      try {
        await fsp.link(temp, path.join(packsDir, file));
        return { file, name: pack.name };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    throw new Error('Could not find a unique pack file name');
  } finally {
    await fsp.rm(temp, { force: true });
  }
}

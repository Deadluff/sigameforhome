/**
 * Steam Workshop → local .siq pack.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { isSiqArchiveAsync, parseSiqAsync, repackWorkshopFolderAsync } from '../packs/parseAsync.ts';
import { downloadToFile, ensureDir, sanitizeSegment, walkFiles } from '../utils/fsx.ts';
import { downloadViaSteamClient, findInLocalSteamLibraries } from './localSteam.ts';
import { steamcmdDownloadItem } from './steamcmd.ts';

export interface WorkshopDetails {
  title: string;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  appId: number;
}

export interface WorkshopProgress {
  stage: string;
  message: string;
  percent?: number;
}

export interface WorkshopDownloadResult {
  id: string;
  title: string;
  file: string;
}

export function parseWorkshopId(input: unknown): string | null {
  const s = String(input ?? '').trim();
  if (/^\d{6,20}$/.test(s)) return s;
  try {
    const url = new URL(s);
    const id = url.searchParams.get('id');
    if (id && /^\d{6,20}$/.test(id)) return id;
  } catch {
    /* not a URL */
  }
  const m = s.match(/(?:CommunityFilePage\/|[?&]id=)(\d{6,20})/i);
  return m ? m[1] : null;
}

export async function getWorkshopDetails(id: string): Promise<WorkshopDetails> {
  const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': id });
  const res = await fetch(config.steam.publishedFileDetailsUrl, {
    method: 'POST', body, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Steam API returned HTTP ${res.status}`);

  const json = (await res.json()) as {
    response?: {
      publishedfiledetails?: Array<{
        result?: number;
        title?: string;
        file_url?: string;
        filename?: string;
        file_size?: number | string;
        consumer_app_id?: number | string;
      }>;
    };
  };
  const details = json?.response?.publishedfiledetails?.[0];
  if (!details || details.result !== 1) {
    throw new Error('Workshop item not found, private, or removed');
  }
  return {
    title: details.title || `workshop_${id}`,
    fileUrl: details.file_url || '',
    fileName: details.filename || '',
    fileSize: Number(details.file_size) || 0,
    appId: Number(details.consumer_app_id) || 0,
  };
}

/** Finds (or builds) a .siq inside a downloaded workshop folder. Returns the source path. */
export async function locatePack(folder: string, workDir: string): Promise<string> {
  const files = await walkFiles(folder);
  // A valid smaller archive is preferable to a larger broken download.
  const siqs = files.filter((f) => f.toLowerCase().endsWith('.siq'));
  if (siqs.length) {
    const sized = await Promise.all(siqs.map(async (f) => ({ f, size: (await fsp.stat(f)).size })));
    for (const { f, size } of sized.sort((a, b) => b.size - a.size)) {
      if (size > 200 * 1024 * 1024) continue;
      try { await parseSiqAsync(f); return f; }
      catch { /* a different file in the item may be a valid pack */ }
    }
  }

  // Some items use a different extension for the archive.
  for (const f of files) {
    if (f.toLowerCase().endsWith('.siq') || !(await isSiqArchiveAsync(f))) continue;
    try { await parseSiqAsync(f); return f; }
    catch { /* keep looking */ }
  }

  const contentXml = files.find((f) => path.basename(f).toLowerCase() === 'content.xml');
  if (contentXml) {
    const out = path.join(workDir, 'repacked.siq');
    await repackWorkshopFolderAsync(path.dirname(contentXml), out);
    return out;
  }
  throw new Error('No SIGame pack (.siq / content.xml) found in the workshop item');
}

/** Streaming hash lets updates reuse identical files without loading a large pack into memory. */
async function fileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** Keep old pack bytes available so saved games never resume against a different board. */
export async function storeWorkshopPack(
  source: string, fileName: string, canPublish: () => boolean = () => true,
): Promise<string> {
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName ||
      !fileName.toLowerCase().endsWith('.siq')) throw new Error('Invalid pack file name');
  await ensureDir(config.packsDir);
  const destination = path.join(config.packsDir, fileName);
  const temporary = path.join(config.packsDir, `.workshop-${crypto.randomUUID()}.tmp`);
  try {
    if ((await fsp.stat(source)).size > 200 * 1024 * 1024) {
      throw new Error('Pack exceeds the 200 MB limit');
    }
    await fsp.copyFile(source, temporary);
    if ((await fsp.stat(temporary)).size > 200 * 1024 * 1024) {
      throw new Error('Pack exceeds the 200 MB limit');
    }
    // parseSiq bounds expanded size and XML before the previous pack is touched.
    await parseSiqAsync(temporary);
    const digest = await fileHash(temporary);
    let installed = destination;
    try {
      if (await fileHash(destination) === digest) {
        if (!canPublish()) throw new Error('Workshop permission was lost');
        return destination;
      }
      const stem = fileName.slice(0, -4);
      installed = path.join(config.packsDir, `${stem}_${digest}.siq`);
      try {
        if (await fileHash(installed) === digest) {
          if (!canPublish()) throw new Error('Workshop permission was lost');
          return installed;
        }
        throw new Error('Versioned pack name is already in use');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Publish without replacing a file that appeared after the hash check.
    // The final permission check and publication run in one event-loop turn.
    if (!canPublish()) throw new Error('Workshop permission was lost');
    try { fs.linkSync(temporary, installed); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && await fileHash(installed) === digest) {
        if (!canPublish()) throw new Error('Workshop permission was lost');
        return installed;
      }
      throw err;
    }
    return installed;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

interface WorkshopRequester {
  onProgress: (progress: WorkshopProgress) => void;
  canPublish: () => boolean;
}

/** Keep separate Workshop ids from starting unlimited downloads and Steam processes. */
const MAX_ACTIVE_JOBS = 2;
const activeJobs = new Map<string, { promise: Promise<WorkshopDownloadResult>; requesters: WorkshopRequester[] }>();

export function downloadWorkshopPack(
  linkOrId: string,
  onProgress: (p: WorkshopProgress) => void = () => {},
  canPublish: () => boolean = () => true,
): Promise<WorkshopDownloadResult> {
  const id = parseWorkshopId(linkOrId);
  if (!id) return Promise.reject(new Error('Could not find a Workshop item id in that link'));
  const requester = { onProgress, canPublish };
  const existing = activeJobs.get(id);
  if (existing) {
    existing.requesters.push(requester);
    return existing.promise;
  }
  if (activeJobs.size >= MAX_ACTIVE_JOBS) {
    return Promise.reject(new Error('Too many Workshop downloads; try again shortly'));
  }

  const requesters = [requester];
  const progress = (update: WorkshopProgress) => {
    for (const item of requesters) item.onProgress(update);
  };
  const mayPublish = () => requesters.some((item) => {
    try { return item.canPublish(); }
    catch { return false; }
  });
  const job = runJob(id, progress, mayPublish).finally(() => activeJobs.delete(id));
  activeJobs.set(id, { promise: job, requesters });
  return job;
}

async function runJob(
  id: string, onProgress: (p: WorkshopProgress) => void, canPublish: () => boolean,
): Promise<WorkshopDownloadResult> {
  const appId = config.steam.sigameAppId;
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `sigame-ws-${id}-`));

  try {
    onProgress({ stage: 'details', message: `Looking up workshop item ${id}…` });
    let details: WorkshopDetails;
    try {
      details = await getWorkshopDetails(id);
    } catch (err) {
      onProgress({ stage: 'details', message: `Steam API lookup failed (${(err as Error).message}); continuing…` });
      details = { title: `workshop_${id}`, fileUrl: '', fileName: '', fileSize: 0, appId: 0 };
    }

    if (details.appId && details.appId !== appId) {
      throw new Error(`This workshop item belongs to another game (app ${details.appId}), not SIGame (${appId})`);
    }
    onProgress({ stage: 'details', message: `Found: "${details.title}"` });

    let sourceFolder: string | null = null;

    if (details.fileUrl) {
      const name = sanitizeSegment(path.basename(details.fileName) || `${id}.siq`);
      const target = path.join(workDir, 'direct', name);
      onProgress({ stage: 'download', message: 'Downloading directly from Steam CDN…', percent: 0 });
      try {
        await downloadToFile(details.fileUrl, target, ({ received, total }) => {
          const t = total || details.fileSize;
          onProgress({
            stage: 'download',
            message: `Downloading… ${(received / 1e6).toFixed(1)} MB`,
            percent: t ? Math.round((received / t) * 100) : undefined,
          });
        });
        sourceFolder = path.dirname(target);
      } catch (err) {
        // Some Workshop entries advertise stale URLs; local Steam can still have the pack.
        onProgress({ stage: 'download', message: `Direct download failed (${(err as Error).message}); checking Steam…` });
      }
    }

    if (!sourceFolder) {
      const cached = await findInLocalSteamLibraries(appId, id);
      if (cached) {
        onProgress({ stage: 'local', message: `Found in local Steam library: ${cached}`, percent: 100 });
        sourceFolder = cached;
      }
    }

    if (!sourceFolder) {
      try {
        sourceFolder = await downloadViaSteamClient(appId, id, (p) =>
          onProgress({ stage: 'steam', message: p.message, percent: p.percent }),
        );
      } catch (steamErr) {
        onProgress({
          stage: 'steam',
          message: `Steam client download unavailable (${(steamErr as Error).message}); falling back to steamcmd…`,
        });
      }
    }

    if (!sourceFolder) {
      onProgress({
        stage: 'steamcmd',
        message: `Downloading via steamcmd (${config.steam.user ? `user ${config.steam.user}` : 'anonymous'})…`,
      });
      sourceFolder = await steamcmdDownloadItem(appId, id, (line) => onProgress({ stage: 'steamcmd', message: line }));
    }

    onProgress({ stage: 'extract', message: 'Locating pack file…' });
    const packSource = await locatePack(sourceFolder, workDir);

    const requestedName = `${sanitizeSegment(details.title, 'workshop').slice(0, 100)}_${id}.siq`;
    if (!canPublish()) throw new Error('Workshop permission was lost');
    const fileName = path.basename(await storeWorkshopPack(packSource, requestedName, canPublish));

    onProgress({ stage: 'done', message: `Saved as ${fileName}`, percent: 100 });
    return { id, title: details.title, file: fileName };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

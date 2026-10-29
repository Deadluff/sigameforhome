/**
 * Steam Workshop → local .siq pack.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../config.ts';
import { isSiqArchive } from '../packs/siqParser.ts';
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
  const res = await fetch(config.steam.publishedFileDetailsUrl, { method: 'POST', body });
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

async function locatePack(folder: string, workDir: string): Promise<string> {
  const files = await walkFiles(folder);

  const siqs = files.filter((f) => f.toLowerCase().endsWith('.siq'));
  if (siqs.length) {
    const sized = await Promise.all(siqs.map(async (f) => ({ f, size: (await fsp.stat(f)).size })));
    return sized.sort((a, b) => b.size - a.size)[0].f;
  }

  for (const f of files) if (isSiqArchive(f)) return f;

  const contentXml = files.find((f) => path.basename(f).toLowerCase() === 'content.xml');
  if (contentXml) {
    const zip = new AdmZip();
    zip.addLocalFolder(path.dirname(contentXml));
    const out = path.join(workDir, 'repacked.siq');
    zip.writeZip(out);
    return out;
  }
  throw new Error('No SIGame pack (.siq / content.xml) found in the workshop item');
}

const activeJobs = new Map<string, Promise<WorkshopDownloadResult>>();

export function downloadWorkshopPack(
  linkOrId: string,
  onProgress: (p: WorkshopProgress) => void = () => {},
): Promise<WorkshopDownloadResult> {
  const id = parseWorkshopId(linkOrId);
  if (!id) return Promise.reject(new Error('Could not find a Workshop item id in that link'));
  const existing = activeJobs.get(id);
  if (existing) return existing;

  const job = runJob(id, onProgress).finally(() => activeJobs.delete(id));
  activeJobs.set(id, job);
  return job;
}

async function runJob(id: string, onProgress: (p: WorkshopProgress) => void): Promise<WorkshopDownloadResult> {
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
      await downloadToFile(details.fileUrl, target, ({ received, total }) => {
        const t = total || details.fileSize;
        onProgress({
          stage: 'download',
          message: `Downloading… ${(received / 1e6).toFixed(1)} MB`,
          percent: t ? Math.round((received / t) * 100) : undefined,
        });
      });
      sourceFolder = path.dirname(target);
    }

    if (!sourceFolder) {
      const cached = await findInLocalSteamLibraries(appId, id);
      if (cached) {
        onProgress({ stage: 'local', message: `Found in local Steam library: ${cached}`, percent: 100 });
        sourceFolder = cached;
      }
    }

    let steamClientError: string | null = null;
    if (!sourceFolder) {
      try {
        sourceFolder = await downloadViaSteamClient(appId, id, (p) =>
          onProgress({ stage: 'steam', message: p.message, percent: p.percent }),
        );
      } catch (steamErr) {
        steamClientError = (steamErr as Error).message;
        onProgress({
          stage: 'steam',
          message: `Steam client download unavailable (${steamClientError}); falling back to steamcmd…`,
        });
      }
    }

    if (!sourceFolder) {
      onProgress({
        stage: 'steamcmd',
        message: `Downloading via steamcmd (${config.steam.user ? `user ${config.steam.user}` : 'anonymous'})…`,
      });
      try {
        sourceFolder = await steamcmdDownloadItem(appId, id, (line) => onProgress({ stage: 'steamcmd', message: line }));
      } catch (cmdErr) {
        const msg = (cmdErr as Error).message;
        if (steamClientError) {
          throw new Error(`${msg} (Local Steam client reason: ${steamClientError})`);
        }
        throw cmdErr;
      }
    }

    onProgress({ stage: 'extract', message: 'Locating pack file…' });
    const packSource = await locatePack(sourceFolder, workDir);

    await ensureDir(config.packsDir);
    const fileName = `${sanitizeSegment(details.title, 'workshop').slice(0, 100)}_${id}.siq`;
    await fsp.copyFile(packSource, path.join(config.packsDir, fileName));

    onProgress({ stage: 'done', message: `Saved as ${fileName}`, percent: 100 });
    return { id, title: details.title, file: fileName };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

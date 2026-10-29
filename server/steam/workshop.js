/**
 * Steam Workshop → local .siq pack.
 *
 * Strategy (cheapest & most reliable first):
 *  1. Ask the public Steam Web API (no API key needed) for the item details.
 *     Validate it belongs to SIGame and get its title.
 *  2. If the API exposes a direct `file_url` (legacy UGC), download it over HTTPS.
 *  3. Check all local Steam library folders (`libraryfolders.vdf`) in case the item
 *     is already subscribed/downloaded on this PC.
 *  4. Ask the running Steam desktop client via Steamworks UGC (`steamworks.js`) to
 *     download the item (`ISteamUGC::DownloadItem`). This uses the user's logged-in
 *     Steam session (which has the depot 3553500 decryption key) with zero credential
 *     prompts and full CDN speed.
 *  5. Fall back to `steamcmd` (requires `STEAM_USER` for encrypted depots).
 *  6. Locate the pack in the downloaded files and copy it into `packs/<Title>_<id>.siq`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../config.js';
import { downloadToFile, ensureDir, sanitizeSegment, walkFiles } from '../utils/fsx.js';
import { isSiqArchive, parseSiq } from '../packs/siqParser.js';
import { downloadViaSteamClient, findInLocalSteamLibraries } from './localSteam.js';
import { steamcmdDownloadItem } from './steamcmd.js';

/**
 * Extracts a workshop id from a URL or a bare id.
 * Accepts: https://steamcommunity.com/sharedfiles/filedetails/?id=123
 *          https://steamcommunity.com/workshop/filedetails/?id=123&searchtext=
 *          steam://url/CommunityFilePage/123
 *          123
 * @returns {string|null}
 */
export function parseWorkshopId(input) {
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

/**
 * Calls ISteamRemoteStorage/GetPublishedFileDetails (public, no key).
 * @returns {Promise<{ title: string, fileUrl: string, fileName: string, fileSize: number, appId: number }>}
 */
export async function getWorkshopDetails(id) {
  const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': id });
  const res = await fetch(config.steam.publishedFileDetailsUrl, { method: 'POST', body });
  if (!res.ok) throw new Error(`Steam API returned HTTP ${res.status}`);

  const details = (await res.json())?.response?.publishedfiledetails?.[0];
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
export async function locatePack(folder, workDir) {
  const files = await walkFiles(folder);

  // 1. Real .siq files – prefer the largest valid one if several.
  const siqs = files.filter((f) => f.toLowerCase().endsWith('.siq'));
  if (siqs.length) {
    const sized = await Promise.all(siqs.map(async (f) => ({ f, size: (await fsp.stat(f)).size })));
    for (const { f, size } of sized.sort((a, b) => b.size - a.size)) {
      if (size > 200 * 1024 * 1024) continue;
      try { await parseSiq(f); return f; }
      catch { /* a different file in the item may be a valid pack */ }
    }
  }

  // 2. Any zip-like file that actually is a pack.
  for (const f of files) {
    if (f.toLowerCase().endsWith('.siq') || !isSiqArchive(f)) continue;
    try { await parseSiq(f); return f; }
    catch { /* keep looking */ }
  }

  // 3. Unpacked pack: a folder with content.xml → zip it.
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

/** Streaming hash lets updates reuse identical files without loading a large pack into memory. */
async function fileHash(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** Keep old pack bytes available so saved games never resume against a different board. */
export async function storeWorkshopPack(source, fileName) {
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
    await parseSiq(temporary);
    const digest = await fileHash(temporary);
    let installed = destination;
    try {
      if (await fileHash(destination) === digest) return destination;
      const stem = fileName.slice(0, -4);
      installed = path.join(config.packsDir, `${stem}_${digest}.siq`);
      try {
        if (await fileHash(installed) === digest) return installed;
        throw new Error('Versioned pack name is already in use');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // Publish without replacing a file that appeared after the hash check.
    try { await fsp.link(temporary, installed); }
    catch (err) {
      if (err.code === 'EEXIST' && await fileHash(installed) === digest) return installed;
      throw err;
    }
    return installed;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Full pipeline. Only one job per workshop id runs at a time.
 * @param {string} linkOrId
 * @param {(p: { stage: string, message: string, percent?: number }) => void} [onProgress]
 * @returns {Promise<{ id: string, title: string, file: string }>} `file` = name inside the packs folder
 */
const activeJobs = new Map();

export function downloadWorkshopPack(linkOrId, onProgress = () => {}) {
  const id = parseWorkshopId(linkOrId);
  if (!id) return Promise.reject(new Error('Could not find a Workshop item id in that link'));
  if (activeJobs.has(id)) return activeJobs.get(id);

  const job = runJob(id, onProgress).finally(() => activeJobs.delete(id));
  activeJobs.set(id, job);
  return job;
}

async function runJob(id, onProgress) {
  const appId = config.steam.sigameAppId;
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `sigame-ws-${id}-`));

  try {
    onProgress({ stage: 'details', message: `Looking up workshop item ${id}…` });
    let details;
    try {
      details = await getWorkshopDetails(id);
    } catch (err) {
      onProgress({ stage: 'details', message: `Steam API lookup failed (${err.message}); continuing…` });
      details = { title: `workshop_${id}`, fileUrl: '', fileName: '', fileSize: 0, appId: 0 };
    }

    if (details.appId && details.appId !== appId) {
      throw new Error(`This workshop item belongs to another game (app ${details.appId}), not SIGame (${appId})`);
    }
    onProgress({ stage: 'details', message: `Found: "${details.title}"` });

    let sourceFolder = null;

    // 1. Direct HTTP download if Steam exposes file_url (legacy UGC).
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
        onProgress({ stage: 'download', message: `Direct download failed (${err.message}); checking Steam…` });
      }
    }

    // 2. Check local Steam library folders (instant if already subscribed/downloaded).
    if (!sourceFolder) {
      const cached = await findInLocalSteamLibraries(appId, id);
      if (cached) {
        onProgress({ stage: 'local', message: `Found in local Steam library: ${cached}`, percent: 100 });
        sourceFolder = cached;
      }
    }

    // 3. Download via the running Steam desktop client (Steamworks ISteamUGC).
    if (!sourceFolder) {
      try {
        sourceFolder = await downloadViaSteamClient(appId, id, (p) =>
          onProgress({ stage: 'steam', message: p.message, percent: p.percent }),
        );
      } catch (steamErr) {
        onProgress({
          stage: 'steam',
          message: `Steam client download unavailable (${steamErr.message}); falling back to steamcmd…`,
        });
      }
    }

    // 4. Fallback: steamcmd.
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
    const fileName = path.basename(await storeWorkshopPack(packSource, requestedName));

    onProgress({ stage: 'done', message: `Saved as ${fileName}`, percent: 100 });
    return { id, title: details.title, file: fileName };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

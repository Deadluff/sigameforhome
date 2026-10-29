/**
 * Local Steam integration for Windows/Desktop:
 *   1. Local Steam Library scanner: reads `libraryfolders.vdf` across all drives
 *      and checks if `<library>/steamapps/workshop/content/3553500/<itemId>` is
 *      already downloaded on disk.
 *   2. Steamworks UGC API (`steamworks.js`): talks directly to the running Steam
 *      desktop client (`ISteamUGC::DownloadItem`), downloading any Workshop pack
 *      at full speed with live byte progress—no username/password required.
 */
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../utils/fsx.ts';

/* EItemState bitmask flags from Steamworks ISteamUGC */
const ITEM_STATE = {
  NONE: 0,
  SUBSCRIBED: 1,
  LEGACY_ITEM: 2,
  INSTALLED: 4,
  NEEDS_UPDATE: 8,
  DOWNLOADING: 16,
  DOWNLOAD_PENDING: 32,
} as const;

export interface SteamClientProgress {
  message: string;
  percent?: number;
}

export async function findSteamInstallPath(): Promise<string | null> {
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    for (const regKey of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
      try {
        const out = execFileSync('reg', ['query', regKey, '/v', 'SteamPath'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
        if (m?.[1]) candidates.push(path.normalize(m[1].trim()));
      } catch {
        /* registry key not present */
      }
    }
    candidates.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(process.env.HOME ?? '', 'Library/Application Support/Steam'));
  } else {
    candidates.push(
      path.join(process.env.HOME ?? '', '.steam/steam'),
      path.join(process.env.HOME ?? '', '.local/share/Steam'),
    );
  }

  for (const dir of candidates) {
    if (dir && (await pathExists(path.join(dir, 'steamapps')))) return dir;
  }
  return null;
}

export async function findSteamLibraryFolders(): Promise<string[]> {
  const steamRoot = await findSteamInstallPath();
  if (!steamRoot) return [];

  const libs = new Set<string>([steamRoot]);
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');

  if (await pathExists(vdfPath)) {
    const content = await fsp.readFile(vdfPath, 'utf8');
    for (const match of content.matchAll(/"path"\s+"([^"]+)"/g)) {
      const libPath = match[1].replace(/\\\\/g, '\\');
      libs.add(path.normalize(libPath));
    }
  }
  return [...libs];
}

export async function findInLocalSteamLibraries(appId: number, itemId: string): Promise<string | null> {
  const libraries = await findSteamLibraryFolders();
  for (const lib of libraries) {
    const candidate = path.join(lib, 'steamapps', 'workshop', 'content', String(appId), String(itemId));
    if (await pathExists(candidate)) {
      const entries = await fsp.readdir(candidate);
      if (entries.length > 0) return candidate;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Steamworks.js client singleton                                            */
/* ------------------------------------------------------------------------- */

type SteamworksClient = ReturnType<typeof import('steamworks.js').init>;

let steamClient: SteamworksClient | null = null;
let steamInitError: Error | null = null;

async function getSteamworksClient(appId: number): Promise<SteamworksClient> {
  if (steamClient) return steamClient;
  if (steamInitError) throw steamInitError;

  try {
    const steamworks = await import('steamworks.js');
    steamClient = steamworks.init(appId);
    return steamClient;
  } catch (err) {
    steamInitError = err as Error;
    setTimeout(() => {
      steamInitError = null;
    }, 5_000).unref();
    throw new Error(
      `Could not connect to the local Steam client (${(err as Error).message}). Make sure the Steam desktop app is running and logged in.`,
    );
  }
}

export async function downloadViaSteamClient(
  appId: number,
  itemId: string,
  onProgress: (p: SteamClientProgress) => void = () => {},
): Promise<string> {
  const client = await getSteamworksClient(appId);
  const idBig = BigInt(itemId);

  const initialState = client.workshop.state(idBig);
  if ((initialState & ITEM_STATE.INSTALLED) && !(initialState & ITEM_STATE.NEEDS_UPDATE)) {
    const info = client.workshop.installInfo(idBig);
    if (info?.folder && (await pathExists(info.folder))) {
      onProgress({ message: `Found in local Steam Workshop cache (${info.folder})`, percent: 100 });
      return info.folder;
    }
  }

  onProgress({ message: 'Requesting download from the running Steam client…', percent: 0 });
  const started = client.workshop.download(idBig, true);
  if (!started) {
    throw new Error(
      'Steam client rejected the download request. Make sure SIGame (App ID 3553500) is added to your free Steam library.',
    );
  }

  const timeoutMs = 10 * 60_000;
  const startTime = Date.now();
  let sawDownloadFlag = false;
  let lastPercent = -1;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, 400));
    const state = client.workshop.state(idBig);

    if (state & (ITEM_STATE.DOWNLOADING | ITEM_STATE.DOWNLOAD_PENDING)) {
      sawDownloadFlag = true;
      const dl = client.workshop.downloadInfo(idBig);
      const current = Number(dl?.current ?? 0n);
      const total = Number(dl?.total ?? 0n);
      if (total > 0) {
        const pct = Math.min(99, Math.round((current / total) * 100));
        if (pct !== lastPercent) {
          lastPercent = pct;
          onProgress({
            message: `Downloading via Steam client… ${(current / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`,
            percent: pct,
          });
        }
      }
      continue;
    }

    if ((state & ITEM_STATE.INSTALLED) && !(state & ITEM_STATE.NEEDS_UPDATE)) {
      const info = client.workshop.installInfo(idBig);
      if (info?.folder && (await pathExists(info.folder))) {
        onProgress({ message: 'Download finished via Steam client.', percent: 100 });
        return info.folder;
      }
    }

    if (sawDownloadFlag && !(state & ITEM_STATE.INSTALLED)) {
      throw new Error(
        'Steam stopped the download before completion. Ensure SIGame (free) is added to your Steam account library.',
      );
    }
  }

  throw new Error('Timed out waiting for Steam client to finish downloading the Workshop item.');
}

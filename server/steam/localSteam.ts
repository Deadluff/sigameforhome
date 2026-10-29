/**
 * Local Steam integration for Windows/Desktop:
 *   1. Local Steam Library scanner: reads `libraryfolders.vdf` across all drives
 *      and checks if `<library>/steamapps/workshop/content/3553500/<itemId>` is
 *      already downloaded on disk.
 *   2. Automatic Steam client health check / wake-up on Windows: verifies that
 *      the local Steam client has an active logged-in user (`ActiveUser != 0`),
 *      automatically starting or recovering a stuck background `-silent` client
 *      after Steam self-updates.
 *   3. Isolated Steamworks UGC worker (`steamworksWorker.ts`): runs `steamworks.js`
 *      in a short-lived child process so each download binds to the current
 *      `steam.exe` IPC pipe and immediately releases `RunningAppID` when done.
 */
import { execFileSync, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists } from '../utils/fsx.ts';
import type { WorkerEvent } from './steamworksWorker.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'steamworksWorker.ts');

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
/* Windows Steam client status & auto-recovery                               */
/* ------------------------------------------------------------------------- */

interface ActiveProcessInfo {
  pid: number;
  activeUser: number;
}

function readWindowsSteamActiveProcess(): ActiveProcessInfo {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const pidMatch = out.match(/\bpid\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    const userMatch = out.match(/\bActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    return {
      pid: pidMatch ? Number.parseInt(pidMatch[1], 16) : 0,
      activeUser: userMatch ? Number.parseInt(userMatch[1], 16) : 0,
    };
  } catch {
    return { pid: 0, activeUser: 0 };
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSteamRunningHeadlessOnWindows(pid: number): boolean {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    ).trim();
    return out === '0' || out === '';
  } catch {
    return false;
  }
}

async function waitForSteamActiveUser(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { pid, activeUser } = readWindowsSteamActiveProcess();
    if (activeUser > 0 && isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

async function ensureSteamClientReady(onProgress: (p: SteamClientProgress) => void): Promise<void> {
  if (process.platform !== 'win32') return;

  const initial = readWindowsSteamActiveProcess();
  if (initial.activeUser > 0 && isProcessAlive(initial.pid)) return;

  const steamRoot = await findSteamInstallPath();
  const steamExe = steamRoot ? path.join(steamRoot, 'steam.exe') : null;
  if (!steamExe || !(await pathExists(steamExe))) return;

  const alive = isProcessAlive(initial.pid);

  if (!alive) {
    onProgress({ message: 'Starting local Steam client in background and waiting for auto-login…' });
    spawn(steamExe, ['-silent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    if (await waitForSteamActiveUser(25_000)) return;
    throw new Error(
      'Started the Steam desktop app, but no account logged in automatically. Open Steam, sign in, and try again.',
    );
  }

  // Steam is running, but ActiveUser is 0 (either still logging in or stuck in -silent after a client update).
  onProgress({ message: 'Waiting for local Steam client to finish logging in…' });
  if (await waitForSteamActiveUser(5_000)) return;

  if (isSteamRunningHeadlessOnWindows(initial.pid)) {
    onProgress({
      message: `Steam background process (PID ${initial.pid}) is stuck with no active user; restarting Steam silently…`,
    });
    try {
      process.kill(initial.pid);
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 2_000));
    spawn(steamExe, ['-silent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    if (await waitForSteamActiveUser(25_000)) {
      onProgress({ message: 'Steam client reconnected and logged in.' });
      return;
    }
  }

  throw new Error(
    `Steam desktop app is running (PID ${initial.pid}) but no account is logged in (ActiveUser = 0). Open the Steam window, sign into your account, and try again.`,
  );
}

/* ------------------------------------------------------------------------- */
/* Child worker runner                                                       */
/* ------------------------------------------------------------------------- */

export async function downloadViaSteamClient(
  appId: number,
  itemId: string,
  onProgress: (p: SteamClientProgress) => void = () => {},
): Promise<string> {
  await ensureSteamClientReady(onProgress);

  return new Promise<string>((resolve, reject) => {
    const packaged = !!process.env.SIGAME_STEAM_WORKER_PATH;
    const args = packaged
      ? [String(appId), String(itemId)]
      : ['--import', 'tsx', WORKER_PATH, String(appId), String(itemId)];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: packaged ? { ...process.env, SIGAME_STEAM_WORKER_MODE: '1' } : process.env,
    });

    let settled = false;
    let lastError = '';
    let stdoutBuf = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('Timed out waiting for Steam client Workshop download worker.'));
      }
    }, 11 * 60_000);

    const handleLine = (line: string) => {
      const idx = line.indexOf('__SW_EVENT__');
      if (idx === -1) return;
      try {
        const event = JSON.parse(line.slice(idx + '__SW_EVENT__'.length)) as WorkerEvent;
        if (event.type === 'progress') {
          onProgress({ message: event.message, percent: event.percent });
        } else if (event.type === 'done' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(event.folder);
        } else if (event.type === 'error') {
          lastError = event.message;
        }
      } catch {
        /* ignore malformed JSON */
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) lastError = text;
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (stdoutBuf) handleLine(stdoutBuf);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            lastError || `Steam client download worker exited unexpectedly (code ${code ?? 'unknown'}).`,
          ),
        );
      }
    });
  });
}

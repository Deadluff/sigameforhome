/**
 * Minimal steamcmd wrapper (fallback when the Steam desktop client is not running).
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../config.ts';
import { downloadToFile, ensureDir, pathExists } from '../utils/fsx.ts';

const IS_WINDOWS = process.platform === 'win32';
const STEAMCMD_DIR = path.join(config.toolsDir, 'steamcmd');
const STEAMCMD_EXE = path.join(STEAMCMD_DIR, IS_WINDOWS ? 'steamcmd.exe' : 'steamcmd.sh');

let bootstrapPromise: Promise<string> | null = null;

export function ensureSteamcmd(onLog: (line: string) => void = () => {}): Promise<string> {
  bootstrapPromise ??= (async (): Promise<string> => {
    if (await pathExists(STEAMCMD_EXE)) return STEAMCMD_EXE;
    if (!IS_WINDOWS) {
      throw new Error('Automatic steamcmd install is only supported on Windows. Install steamcmd and place it in tools/steamcmd.');
    }
    await ensureDir(STEAMCMD_DIR);
    const zipPath = path.join(STEAMCMD_DIR, 'steamcmd.zip');
    onLog('Downloading steamcmd from Valve…');
    await downloadToFile(config.steam.steamcmdZipUrl, zipPath);
    new AdmZip(zipPath).extractAllTo(STEAMCMD_DIR, true);
    onLog('steamcmd installed. The first run will self-update, this can take a minute.');
    return STEAMCMD_EXE;
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });
  return bootstrapPromise;
}

interface SteamcmdRunResult {
  code: number | null;
  output: string;
}

function runSteamcmd(exe: string, args: string[], onLog: (line: string) => void): Promise<SteamcmdRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: STEAMCMD_DIR, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('steamcmd timed out'));
    }, config.steam.steamcmdTimeoutMs);

    const onData = (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      output += chunk;
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) onLog(line.trim());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function readWorkshopLogError(itemId: string): Promise<string | null> {
  const logPath = path.join(STEAMCMD_DIR, 'logs', 'workshop_log.txt');
  try {
    const text = await fsp.readFile(logPath, 'utf8');
    const lines = text.trim().split(/\r?\n/).slice(-25).join('\n');
    if (/Missing decryption key/i.test(lines)) {
      return (
        `Steam denied the depot decryption key for item ${itemId} to anonymous steamcmd. ` +
        `Start the Steam desktop client (logged into an account with SIGame in its library) and try again, ` +
        `or set STEAM_USER / STEAM_PASS environment variables.`
      );
    }
    if (!config.steam.user && /Failed downloading \d+ manifests \(No connection\)/i.test(lines)) {
      return (
        `Steam blocked anonymous steamcmd from downloading the Workshop manifest for item ${itemId} (SIGame depot 3553500 requires a logged-in Steam account). ` +
        `Make sure the Steam desktop app is open and signed into an account with SIGame (free) in its library, or set STEAM_USER / STEAM_PASS.`
      );
    }
  } catch {
    /* ignore missing log */
  }
  return null;
}

export async function steamcmdDownloadItem(
  appId: number,
  itemId: string,
  onLog: (line: string) => void = () => {},
): Promise<string> {
  const exe = await ensureSteamcmd(onLog);
  const loginArgs = config.steam.user
    ? ['+login', config.steam.user, ...(config.steam.pass ? [config.steam.pass] : [])]
    : ['+login', 'anonymous'];
  const args = [...loginArgs, '+workshop_download_item', String(appId), String(itemId), 'validate', '+quit'];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { code, output } = await runSteamcmd(exe, args, onLog);

    const success = output.match(/Success\. Downloaded item \d+ to "([^"]+)"/);
    if (success) return success[1];

    const failure = output.match(/ERROR! Download item \d+ failed \(([^)]+)\)/);
    if (failure) {
      const detailed = await readWorkshopLogError(itemId);
      if (detailed) throw new Error(detailed);

      const reason = failure[1];
      const hint = /no connection/i.test(reason)
        ? ' Check your internet connection.'
        : /access denied|no subscription|failure/i.test(reason)
          ? ' Make sure the Steam desktop app is running, or configure STEAM_USER.'
          : '';
      throw new Error(`steamcmd: ${reason}.${hint}`);
    }

    for (const candidate of [
      path.join(STEAMCMD_DIR, 'steamapps', 'workshop', 'content', String(appId), String(itemId)),
      path.join(STEAMCMD_DIR, 'steamapps', 'content', String(appId), String(itemId)),
    ]) {
      if (await pathExists(candidate)) return candidate;
    }

    onLog(`steamcmd exited with code ${code}${attempt === 1 ? ', retrying…' : ''}`);
  }
  throw new Error('steamcmd did not download the item. See log for details.');
}

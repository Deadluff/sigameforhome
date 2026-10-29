/**
 * Minimal steamcmd wrapper (fallback when the Steam desktop client is not running).
 */
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { config } from '../config.ts';
import { downloadToFile, ensureDir, pathExists } from '../utils/fsx.ts';

const IS_WINDOWS = process.platform === 'win32';
const STEAMCMD_DIR = path.join(config.toolsDir, 'steamcmd');
const STEAMCMD_EXE = path.join(STEAMCMD_DIR, IS_WINDOWS ? 'steamcmd.exe' : 'steamcmd.sh');
const execFileAsync = promisify(execFile);

let bootstrapPromise: Promise<string> | null = null;

/** Steamcmd may echo commands, including +login credentials, into its logs. */
export function redactSteamLog(line: string, password = config.steam.pass): string {
  return password ? line.replaceAll(password, '[redacted]') : line;
}

/** Forward only complete, reasonably sized lines so split secrets cannot leak. */
export function createSteamLogForwarder(onLog: (line: string) => void, password = config.steam.pass) {
  let partialLine = '';
  let droppingLine = false;
  const emit = () => {
    if (!droppingLine && partialLine.trim()) onLog(redactSteamLog(partialLine.trim(), password));
    partialLine = '';
    droppingLine = false;
  };
  return {
    write(chunk: string) {
      for (const part of chunk.split(/(\r\n|\n|\r)/)) {
        if (part === '\r\n' || part === '\n' || part === '\r') {
          emit();
        } else if (!droppingLine) {
          if (partialLine.length + part.length <= 4096) partialLine += part;
          else { partialLine = ''; droppingLine = true; }
        }
      }
    },
    finish: emit,
  };
}

/** Concurrent callers share the same bootstrap promise. */
export function ensureSteamcmd(onLog: (line: string) => void = () => {}): Promise<string> {
  bootstrapPromise ??= (async (): Promise<string> => {
    if (await pathExists(STEAMCMD_EXE)) return STEAMCMD_EXE;
    if (!IS_WINDOWS && process.platform !== 'darwin') {
      throw new Error('Automatic steamcmd install is only supported on Windows and macOS. Install steamcmd and place it in tools/steamcmd.');
    }
    await ensureDir(STEAMCMD_DIR);
    onLog('Downloading steamcmd from Valve…');
    if (IS_WINDOWS) {
      const zipPath = path.join(STEAMCMD_DIR, 'steamcmd.zip');
      await downloadToFile(config.steam.steamcmdZipUrl, zipPath);
      new AdmZip(zipPath).extractAllTo(STEAMCMD_DIR, true);
    } else {
      // Valve ships macOS SteamCMD as a tarball, while Windows uses a zip.
      const archivePath = path.join(STEAMCMD_DIR, 'steamcmd_osx.tar.gz');
      await downloadToFile(config.steam.steamcmdMacUrl, archivePath);
      await execFileAsync('tar', ['-xzf', archivePath, '-C', STEAMCMD_DIR]);
      await fsp.chmod(STEAMCMD_EXE, 0o755);
    }
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
    const maxOutputChars = 256 * 1024;
    const stdoutLogs = createSteamLogForwarder(onLog);
    const stderrLogs = createSteamLogForwarder(onLog);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('steamcmd timed out'));
    }, config.steam.steamcmdTimeoutMs);

    const onData = (logs: ReturnType<typeof createSteamLogForwarder>) => (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      // Keep enough tail text for success/failure matching without retaining a long session log.
      output = (output + chunk).slice(-maxOutputChars);
      logs.write(chunk);
    };
    child.stdout.on('data', onData(stdoutLogs));
    child.stderr.on('data', onData(stderrLogs));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stdoutLogs.finish();
      stderrLogs.finish();
      resolve({ code, output });
    });
  });
}

async function readWorkshopLogError(itemId: string): Promise<string | null> {
  // macOS SteamCMD writes Workshop logs to Steam's user data directory.
  const logDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/Steam/logs')
    : path.join(STEAMCMD_DIR, 'logs');
  const logPath = path.join(logDir, 'workshop_log.txt');
  try {
    const text = await fsp.readFile(logPath, 'utf8');
    const itemStart = text.lastIndexOf(`Download item ${itemId} requested`);
    if (itemStart === -1) return null;
    const lines = text.slice(itemStart).trim().split(/\r?\n/).slice(0, 25).join('\n');
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

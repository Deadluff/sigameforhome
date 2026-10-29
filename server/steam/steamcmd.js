/**
 * Minimal steamcmd wrapper (fallback when the Steam desktop client is not running).
 *
 * Note on SIGame (App ID 3553500):
 *   Valve encrypts depot 3553500 and denies decryption keys to `login anonymous`
 *   (`Missing decryption key` in workshop_log.txt). Therefore, steamcmd can only
 *   download SIGame packs when logged into a Steam account that has SIGame (free)
 *   in its library (`STEAM_USER` / `STEAM_PASS` env vars or cached credentials).
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../config.js';
import { downloadToFile, ensureDir, pathExists } from '../utils/fsx.js';

const IS_WINDOWS = process.platform === 'win32';
const STEAMCMD_DIR = path.join(config.toolsDir, 'steamcmd');
const STEAMCMD_EXE = path.join(STEAMCMD_DIR, IS_WINDOWS ? 'steamcmd.exe' : 'steamcmd.sh');

let bootstrapPromise = null;

/** Steamcmd may echo commands, including +login credentials, into its logs. */
export function redactSteamLog(line, password = config.steam.pass) {
  return password ? line.replaceAll(password, '[redacted]') : line;
}

/** Forward only complete, reasonably sized lines so split secrets cannot leak. */
export function createSteamLogForwarder(onLog, password = config.steam.pass) {
  let partialLine = '';
  let droppingLine = false;
  const emit = () => {
    if (!droppingLine && partialLine.trim()) onLog(redactSteamLog(partialLine.trim(), password));
    partialLine = '';
    droppingLine = false;
  };
  return {
    write(chunk) {
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

/**
 * Makes sure steamcmd exists locally, downloading it if needed.
 * Concurrent callers share the same bootstrap promise.
 */
export function ensureSteamcmd(onLog = () => {}) {
  bootstrapPromise ??= (async () => {
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
    bootstrapPromise = null; // allow retry
    throw err;
  });
  return bootstrapPromise;
}

/** Runs steamcmd with the given +commands, streaming output lines to onLog. */
function runSteamcmd(exe, args, onLog) {
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

    const onData = (logs) => (buf) => {
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

/**
 * Inspects `tools/steamcmd/logs/workshop_log.txt` for the specific underlying failure reason
 * when steamcmd only prints the generic `failed (Failure)` message on stdout.
 */
async function readWorkshopLogError(itemId) {
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
  } catch {
    /* ignore missing log */
  }
  return null;
}

/**
 * Downloads a workshop item via steamcmd.
 * @param {number} appId
 * @param {string} itemId
 * @param {(line: string) => void} onLog
 * @returns {Promise<string>} absolute path of the folder containing the item files
 */
export async function steamcmdDownloadItem(appId, itemId, onLog = () => {}) {
  const exe = await ensureSteamcmd(onLog);
  const loginArgs = config.steam.user
    ? ['+login', config.steam.user, ...(config.steam.pass ? [config.steam.pass] : [])]
    : ['+login', 'anonymous'];
  const args = [...loginArgs, '+workshop_download_item', String(appId), String(itemId), 'validate', '+quit'];

  // steamcmd frequently exits right after self-updating on the first run, so retry once.
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

    // Fallback: the folder may exist even if the success line was not captured.
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

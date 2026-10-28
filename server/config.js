/**
 * Central configuration. Every value can be overridden with an environment
 * variable so the same build works from start.bat, Docker, or a dev shell.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (one level above /server). */
export const ROOT_DIR = path.resolve(__dirname, '..');

const env = (name, fallback) => process.env[name] ?? fallback;

export const config = Object.freeze({
  /** HTTP + WebSocket port. */
  port: Number(env('PORT', 3000)),

  /** Bind address. 0.0.0.0 = reachable from the LAN. */
  host: env('HOST', '0.0.0.0'),

  /** Folder where the host drops .siq files (and where Steam downloads land). */
  packsDir: path.resolve(env('PACKS_DIR', path.join(ROOT_DIR, 'packs'))),

  /** Extracted pack media is cached here, one sub-folder per pack hash. */
  cacheDir: path.resolve(env('CACHE_DIR', path.join(ROOT_DIR, 'data', 'cache'))),

  /** Third-party tools (steamcmd) are bootstrapped here on demand. */
  toolsDir: path.resolve(env('TOOLS_DIR', path.join(ROOT_DIR, 'tools'))),

  /** Static web client. Will point to the React build (client/dist) in Step 5. */
  publicDir: path.resolve(env('PUBLIC_DIR', path.join(ROOT_DIR, 'public'))),

  /** How long a disconnected participant keeps their seat (ms). Phones drop sockets a lot. */
  reconnectGraceMs: Number(env('RECONNECT_GRACE_MS', 90_000)),

  steam: Object.freeze({
    /** SIGame's Steam App ID – workshop items are published under it. */
    sigameAppId: Number(env('SIGAME_APP_ID', 3553500)),
    publishedFileDetailsUrl:
      'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
    steamcmdZipUrl: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
    /** Hard timeout for a single steamcmd run (first run self-updates, so be generous). */
    steamcmdTimeoutMs: Number(env('STEAMCMD_TIMEOUT_MS', 15 * 60_000)),
    /** Optional Steam credentials for steamcmd fallback (when Steam desktop app isn't running). */
    user: env('STEAM_USER', ''),
    pass: env('STEAM_PASS', ''),
  }),
});

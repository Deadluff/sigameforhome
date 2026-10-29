/**
 * Central configuration. Every value can be overridden with an environment
 * variable so the same build works from start.bat, start.sh, Docker, or a dev shell.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (one level above /server). */
export const ROOT_DIR: string = process.env.SIGAME_ROOT_DIR ?? path.resolve(__dirname, '..');

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

export interface SteamConfig {
  readonly sigameAppId: number;
  readonly publishedFileDetailsUrl: string;
  readonly steamcmdZipUrl: string;
  readonly steamcmdMacUrl: string;
  readonly steamcmdTimeoutMs: number;
  readonly user: string;
  readonly pass: string;
}

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly packsDir: string;
  readonly cacheDir: string;
  readonly toolsDir: string;
  readonly publicDir: string;
  readonly roomStateFile: string;
  readonly reconnectGraceMs: number;
  readonly steam: SteamConfig;
}

export const config: AppConfig = Object.freeze({
  /** HTTP + WebSocket port. */
  port: Number(env('PORT', '3000')),

  /** Bind address. 0.0.0.0 = reachable from the LAN. */
  host: env('HOST', '0.0.0.0'),

  /** Folder where the host drops .siq files (and where Steam downloads land). */
  packsDir: path.resolve(env('PACKS_DIR', path.join(ROOT_DIR, 'packs'))),

  /** Extracted pack media is cached here, one sub-folder per pack hash. */
  cacheDir: path.resolve(env('CACHE_DIR', path.join(ROOT_DIR, 'data', 'cache'))),

  /** Optional isolated state file for testing or multiple local instances. */
  roomStateFile: path.resolve(env('ROOM_STATE_FILE', path.join(ROOT_DIR, 'data', 'room-state.json'))),

  /** Third-party tools (steamcmd) are bootstrapped here on demand. */
  toolsDir: path.resolve(env('TOOLS_DIR', path.join(ROOT_DIR, 'tools'))),

  /** Serve the built Vite client. PUBLIC_DIR remains available for custom deployments. */
  publicDir: path.resolve(env('PUBLIC_DIR', path.join(ROOT_DIR, 'client', 'dist'))),

  /** How long a disconnected participant keeps their seat (ms). Phones drop sockets a lot. */
  reconnectGraceMs: Number(env('RECONNECT_GRACE_MS', '90000')),

  steam: Object.freeze({
    /** SIGame's Steam App ID – workshop items are published under it. */
    sigameAppId: Number(env('SIGAME_APP_ID', '3553500')),
    publishedFileDetailsUrl:
      'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
    steamcmdZipUrl: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
    steamcmdMacUrl: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz',
    /** Hard timeout for a single steamcmd run (first run self-updates, so be generous). */
    steamcmdTimeoutMs: Number(env('STEAMCMD_TIMEOUT_MS', String(15 * 60_000))),
    /** Optional Steam credentials for steamcmd fallback (when Steam desktop app isn't running). */
    user: env('STEAM_USER', ''),
    pass: env('STEAM_PASS', ''),
  }),
});

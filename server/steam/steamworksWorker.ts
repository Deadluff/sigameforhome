/**
 * Short-lived child worker that initializes `steamworks.js`, downloads a
 * single Workshop item via `ISteamUGC::DownloadItem`, emits JSON lines on
 * stdout, and exits immediately so Steam releases `RunningAppID` and future
 * downloads always bind to the current `steam.exe` IPC pipe.
 */
import fsp from 'node:fs/promises';

const ITEM_STATE = {
  NONE: 0,
  SUBSCRIBED: 1,
  LEGACY_ITEM: 2,
  INSTALLED: 4,
  NEEDS_UPDATE: 8,
  DOWNLOADING: 16,
  DOWNLOAD_PENDING: 32,
} as const;

export type WorkerEvent =
  | { type: 'progress'; message: string; percent?: number }
  | { type: 'done'; folder: string }
  | { type: 'error'; message: string };

function emit(event: WorkerEvent): void {
  process.stdout.write(`__SW_EVENT__${JSON.stringify(event)}\n`);
}

async function dirHasFiles(dir: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const appId = Number(process.argv[2]);
  const itemId = process.argv[3];

  if (!appId || !itemId) {
    emit({ type: 'error', message: 'Usage: steamworksWorker.ts <appId> <itemId>' });
    process.exit(1);
  }

  let client: ReturnType<typeof import('steamworks.js').init>;
  try {
    const steamworks = (await import(process.env.SIGAME_STEAMWORKS_PATH ?? 'steamworks.js')).default as typeof import('steamworks.js');
    client = steamworks.init(appId);
  } catch (err) {
    emit({
      type: 'error',
      message: `Could not connect to the local Steam client (${(err as Error).message}). Make sure the Steam desktop app is running and logged in.`,
    });
    process.exit(1);
  }

  const idBig = BigInt(itemId);
  const initialState = client.workshop.state(idBig);
  if ((initialState & ITEM_STATE.INSTALLED) && !(initialState & ITEM_STATE.NEEDS_UPDATE)) {
    const info = client.workshop.installInfo(idBig);
    if (info?.folder && (await dirHasFiles(info.folder))) {
      emit({ type: 'progress', message: `Found in local Steam Workshop cache (${info.folder})`, percent: 100 });
      emit({ type: 'done', folder: info.folder });
      process.exit(0);
    }
  }

  emit({ type: 'progress', message: 'Requesting download from the running Steam client…', percent: 0 });
  const started = client.workshop.download(idBig, true);
  if (!started) {
    emit({
      type: 'error',
      message:
        'Steam client rejected the download request. Make sure SIGame (App ID 3553500) is added to your free Steam library.',
    });
    process.exit(1);
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
          emit({
            type: 'progress',
            message: `Downloading via Steam client… ${(current / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`,
            percent: pct,
          });
        }
      }
      continue;
    }

    if ((state & ITEM_STATE.INSTALLED) && !(state & ITEM_STATE.NEEDS_UPDATE)) {
      const info = client.workshop.installInfo(idBig);
      if (info?.folder && (await dirHasFiles(info.folder))) {
        emit({ type: 'progress', message: 'Download finished via Steam client.', percent: 100 });
        emit({ type: 'done', folder: info.folder });
        process.exit(0);
      }
    }

    if (sawDownloadFlag && !(state & ITEM_STATE.INSTALLED)) {
      emit({
        type: 'error',
        message:
          'Steam stopped the download before completion. Ensure SIGame (free) is added to your Steam account library.',
      });
      process.exit(1);
    }
  }

  emit({ type: 'error', message: 'Timed out waiting for Steam client to finish downloading the Workshop item.' });
  process.exit(1);
}

main().catch((err) => {
  emit({ type: 'error', message: (err as Error)?.message || String(err) });
  process.exit(1);
});

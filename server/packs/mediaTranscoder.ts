/**
 * Apple / iOS / iPadOS media compatibility layer.
 *
 * Inspects media files and transparently transcodes incompatible video/audio
 * (AV1/VP9/Opus) into universally supported H.264 (`yuv420p`) + AAC (`+faststart`
 * for HTTP byte-range streaming required by Safari).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { pathExists, walkFiles } from '../utils/fsx.ts';

const execFileAsync = promisify(execFile);
const ffmpegPath = ffmpegStatic as unknown as string | null;

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi']);
const AUDIO_EXTS = new Set(['.ogg', '.opus', '.weba', '.flac']);
export const MAX_CONCURRENT_TRANSCODES = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2)));

let runningTranscodes = 0;
const waitingTranscodes: Array<() => void> = [];

/** Every pack warmup and HTTP conversion shares the same process-wide ffmpeg limit. */
export async function runTranscodeTask<T>(task: () => Promise<T>): Promise<T> {
  if (runningTranscodes < MAX_CONCURRENT_TRANSCODES) runningTranscodes++;
  else await new Promise<void>((resolve) => waitingTranscodes.push(resolve));
  try {
    return await task();
  } finally {
    // Transfer the occupied slot to the next waiter before a new request can take it.
    const next = waitingTranscodes.shift();
    if (next) next();
    else runningTranscodes--;
  }
}

/** In-flight transcode promises keyed by absolute file path so concurrent requests share one job. */
const activeTranscodes = new Map<string, Promise<string>>();

/**
 * Inspects an MP4/MOV file's header/boxes to check if it is already iOS-compatible
 * (H.264 `avc1` video and no `av01` / `vp09` / `Opus` / `vorb` tracks).
 */
export async function needsIosVideoTranscode(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return false;
  if (ext !== '.mp4' && ext !== '.m4v' && ext !== '.mov') {
    return true;
  }

  try {
    let marker = false;
    let unsupported = false;
    let hasH264 = false;
    let tail = '';
    // Codec tags may be near the end of an MP4; scan it in bounded chunks instead of loading gigabytes.
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
      const latin = tail + chunk.toString('latin1');
      marker ||= latin.includes('sigamelocal-ios');
      unsupported ||= ['av01', 'vp09', 'vp08', 'hvc1', 'hev1', 'Opus', 'dOps', 'vorb'].some((tag) => latin.includes(tag));
      hasH264 ||= latin.includes('avc1');
      tail = latin.slice(-15);
    }
    return !marker && (unsupported || !hasH264);
  } catch {
    return false;
  }
}

export function needsIosAudioTranscode(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

/**
 * Transcodes a single video/audio file in-place to H.264 (yuv420p) + AAC with `+faststart`
 * so iPhone, iPad, Android, and desktop browsers can all stream it via HTTP Range requests.
 */
export function ensureIosCompatibleMedia(filePath: string, packCacheDir: string | null = null): Promise<string> {
  const existing = activeTranscodes.get(filePath);
  if (existing) return existing;

  const job = (async (): Promise<string> => {
    if (!ffmpegPath || !(await pathExists(filePath))) return filePath;

    // Keep generated files outside the archive's media folders. A pack may contain a
    // file named clip.webm.ios.mp4, so an adjacent derivative is not trustworthy.
    const derivative = (ext: 'mp4' | 'mp3'): string => packCacheDir
      ? path.join(packCacheDir, '_derived', `${path.relative(packCacheDir, filePath)}.ios.${ext}`)
      : `${filePath}.ios.${ext}`;
    const cachedVideo = derivative('mp4');
    if (VIDEO_EXTS.has(path.extname(filePath).toLowerCase()) && await pathExists(cachedVideo)) return cachedVideo;
    const cachedAudio = derivative('mp3');
    if (needsIosAudioTranscode(filePath) && await pathExists(cachedAudio)) return cachedAudio;

    if (await needsIosVideoTranscode(filePath)) {
      const converted = cachedVideo;
      if (await pathExists(converted)) return converted;
      const tmpOut = `${converted}.${process.pid}.${Date.now()}.tmp.mp4`;
      try {
        await fsp.mkdir(path.dirname(converted), { recursive: true });
        await runTranscodeTask(() => execFileAsync(
          ffmpegPath,
          [
            '-y',
            '-i',
            filePath,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-vf',
            'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-pix_fmt',
            'yuv420p',
            '-crf',
            '25',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-ac',
            '2',
            '-metadata',
            'comment=sigamelocal-ios',
            '-movflags',
            '+faststart',
            tmpOut,
          ],
          { windowsHide: true, timeout: 120_000 },
        ));
        await fsp.rename(tmpOut, converted);
      } catch (err) {
        await fsp.rm(tmpOut, { force: true }).catch(() => {});
        console.warn(`[transcode] Failed to convert video ${path.basename(filePath)}: ${(err as Error).message}`);
      }
      return (await pathExists(converted)) ? converted : filePath;
    }

    if (needsIosAudioTranscode(filePath)) {
      const converted = cachedAudio;
      if (await pathExists(converted)) return converted;
      const tmpOut = `${converted}.${process.pid}.${Date.now()}.tmp.mp3`;
      try {
        await fsp.mkdir(path.dirname(converted), { recursive: true });
        await runTranscodeTask(() => execFileAsync(
          ffmpegPath,
          ['-y', '-i', filePath, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', tmpOut],
          { windowsHide: true, timeout: 60_000 },
        ));
        await fsp.rename(tmpOut, converted);
      } catch (err) {
        await fsp.rm(tmpOut, { force: true }).catch(() => {});
        console.warn(`[transcode] Failed to convert audio ${path.basename(filePath)}: ${(err as Error).message}`);
      }
      return (await pathExists(converted)) ? converted : filePath;
    }

    return filePath;
  })().finally(() => activeTranscodes.delete(filePath));

  activeTranscodes.set(filePath, job);
  return job;
}

/**
 * Warms up all videos/audio in an extracted pack cache folder in the background
 * using a small worker pool so gameplay is never blocked.
 */
export async function backgroundTranscodePackMedia(cacheDir: string): Promise<void> {
  if (!ffmpegPath || !(await pathExists(cacheDir))) return;
  const files = await walkFiles(cacheDir);
  const candidates: string[] = [];

  for (const f of files) {
    if (!f.endsWith('.ios.mp4') && !f.endsWith('.ios.mp3') &&
        ((await needsIosVideoTranscode(f)) || needsIosAudioTranscode(f))) {
      candidates.push(f);
    }
  }
  if (!candidates.length) return;

  const concurrency = MAX_CONCURRENT_TRANSCODES;
  console.log(`[media] Pre-converting ${candidates.length} media file(s) for iPhone/iPad compatibility…`);

  let index = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    while (index < candidates.length) {
      const file = candidates[index++];
      if (await ensureIosCompatibleMedia(file, cacheDir) === file) failed++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failed) console.warn(`[media] ${failed} of ${candidates.length} file(s) in ${path.basename(cacheDir)} could not be converted.`);
  else console.log(`[media] All ${candidates.length} media file(s) in ${path.basename(cacheDir)} are now iOS-compatible.`);
}

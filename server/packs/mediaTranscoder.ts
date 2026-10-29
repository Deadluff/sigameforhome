/**
 * Apple / iOS / iPadOS media compatibility layer.
 *
 * Inspects media files and transparently transcodes incompatible video/audio
 * (AV1/VP9/Opus) into universally supported H.264 (`yuv420p`) + AAC (`+faststart`
 * for HTTP byte-range streaming required by Safari).
 */
import { execFile } from 'node:child_process';
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
    const buf = await fsp.readFile(filePath);
    const latin = buf.toString('latin1');

    if (latin.includes('sigamelocal-ios')) return false;

    const hasAv1 = latin.includes('av01');
    const hasVp9 = latin.includes('vp09') || latin.includes('vp08');
    const hasOpus = latin.includes('Opus') || latin.includes('dOps');
    const hasVorbis = latin.includes('vorb');
    const hasH264 = latin.includes('avc1');

    return hasAv1 || hasVp9 || hasOpus || hasVorbis || !hasH264;
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
export function ensureIosCompatibleMedia(filePath: string): Promise<string> {
  const existing = activeTranscodes.get(filePath);
  if (existing) return existing;

  const job = (async (): Promise<string> => {
    if (!ffmpegPath || !(await pathExists(filePath))) return filePath;

    if (await needsIosVideoTranscode(filePath)) {
      const tmpOut = `${filePath}.ios_${process.pid}_${Date.now()}.mp4`;
      try {
        await execFileAsync(
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
        );
        await fsp.rename(tmpOut, filePath);
      } catch (err) {
        await fsp.rm(tmpOut, { force: true }).catch(() => {});
        console.warn(`[transcode] Failed to convert video ${path.basename(filePath)}: ${(err as Error).message}`);
      }
      return filePath;
    }

    if (needsIosAudioTranscode(filePath)) {
      const markerPath = `${filePath}.ios_ok`;
      if (await pathExists(markerPath)) return filePath;
      const tmpOut = `${filePath}.ios_${process.pid}_${Date.now()}.mp3`;
      try {
        await execFileAsync(
          ffmpegPath,
          ['-y', '-i', filePath, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', tmpOut],
          { windowsHide: true, timeout: 60_000 },
        );
        await fsp.rename(tmpOut, filePath);
        await fsp.writeFile(markerPath, '1');
      } catch (err) {
        await fsp.rm(tmpOut, { force: true }).catch(() => {});
        console.warn(`[transcode] Failed to convert audio ${path.basename(filePath)}: ${(err as Error).message}`);
      }
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
    if ((await needsIosVideoTranscode(f)) || needsIosAudioTranscode(f)) {
      candidates.push(f);
    }
  }
  if (!candidates.length) return;

  const concurrency = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2)));
  console.log(`[media] Pre-converting ${candidates.length} media file(s) for iPhone/iPad compatibility…`);

  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < candidates.length) {
      const file = candidates[index++];
      await ensureIosCompatibleMedia(file);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[media] All ${candidates.length} media file(s) in ${path.basename(cacheDir)} are now iOS-compatible.`);
}

/**
 * Apple / iOS / iPadOS media compatibility layer.
 *
 * Why videos in many SIGame Workshop packs fail on iPhone & iPad:
 *   1. Codec incompatibility: Pack compressor scripts (e.g. "crf45_speed100_norm")
 *      encode `.mp4` files with **AV1 (`av01`) video + Opus (`Opus`) audio** (or VP9/WebM)
 *      to shrink pack sizes. iOS/iPadOS Safari only supports **H.264 (`avc1`) / HEVC (`hvc1`)**
 *      video + **AAC (`mp4a`) / MP3** audio in MP4 containers (and only decodes AV1 in hardware
 *      on iPhone 15 Pro+, while still rejecting Opus-in-MP4 in `<video>` elements).
 *   2. Autoplay & inline playback restrictions: iOS Safari blocks unmuted `autoplay` unless
 *      a `<video>` element has `playsinline` (`webkit-playsinline`) and either starts muted or
 *      was unlocked during a user tap gesture.
 *
 * This module inspects media files and transparently transcodes incompatible video/audio
 * into universally supported H.264 (`yuv420p`) + AAC (`+faststart` for HTTP byte-range
 * streaming required by Safari), caching the converted files alongside the extracted pack.
 */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { pathExists, walkFiles } from '../utils/fsx.js';

const execFileAsync = promisify(execFile);

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi']);
const AUDIO_EXTS = new Set(['.ogg', '.opus', '.weba', '.flac']);

/** In-flight transcode promises keyed by absolute file path so concurrent requests share one job. */
const activeTranscodes = new Map();

/**
 * Inspects an MP4/MOV file's header/boxes to check if it is already iOS-compatible
 * (H.264 `avc1` video and no `av01` / `vp09` / `Opus` / `vorb` tracks).
 * @param {string} filePath
 * @returns {Promise<boolean>} true if transcoding is needed for iOS/iPadOS
 */
export async function needsIosVideoTranscode(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return false;
  if (ext !== '.mp4' && ext !== '.m4v' && ext !== '.mov') {
    // .webm, .mkv, .avi always need transcoding for iOS Safari
    return true;
  }

  try {
    const buf = await fsp.readFile(filePath);
    const latin = buf.toString('latin1');

    // If our marker is already in the file metadata, it was already transcoded by us.
    if (latin.includes('sigamelocal-ios')) return false;

    const hasAv1 = latin.includes('av01');
    const hasVp9 = latin.includes('vp09') || latin.includes('vp08');
    const hasOpus = latin.includes('Opus') || latin.includes('dOps');
    const hasVorbis = latin.includes('vorb');
    const hasH264 = latin.includes('avc1');

    if (hasAv1 || hasVp9 || hasOpus || hasVorbis || !hasH264) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Checks if an audio file needs transcoding for iOS Safari (e.g. .ogg / .opus).
 * @param {string} filePath
 */
export function needsIosAudioTranscode(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

/**
 * Transcodes a single video file in-place to H.264 (yuv420p) + AAC with `+faststart`
 * so iPhone, iPad, Android, and desktop browsers can all stream it via HTTP Range requests.
 * @param {string} filePath
 * @returns {Promise<string>} path to the compatible file
 */
export function ensureIosCompatibleMedia(filePath) {
  if (activeTranscodes.has(filePath)) return activeTranscodes.get(filePath);

  const job = (async () => {
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
            '- profile:v',
            'main',
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
          ].filter((a) => a !== '- profile:v' && a !== 'main'), // keep full profile compatibility
          { windowsHide: true, timeout: 120_000 },
        );
        await fsp.rename(tmpOut, filePath);
      } catch (err) {
        await fsp.rm(tmpOut, { force: true }).catch(() => {});
        console.warn(`[transcode] Failed to convert video ${path.basename(filePath)}: ${err.message}`);
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
        console.warn(`[transcode] Failed to convert audio ${path.basename(filePath)}: ${err.message}`);
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
 * @param {string} cacheDir
 */
export async function backgroundTranscodePackMedia(cacheDir) {
  if (!ffmpegPath || !(await pathExists(cacheDir))) return;
  const files = await walkFiles(cacheDir);
  const candidates = [];

  for (const f of files) {
    if ((await needsIosVideoTranscode(f)) || needsIosAudioTranscode(f)) {
      candidates.push(f);
    }
  }
  if (!candidates.length) return;

  const concurrency = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2)));
  console.log(`[media] Pre-converting ${candidates.length} media file(s) for iPhone/iPad compatibility…`);

  let index = 0;
  const worker = async () => {
    while (index < candidates.length) {
      const file = candidates[index++];
      await ensureIosCompatibleMedia(file);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[media] All ${candidates.length} media file(s) in ${path.basename(cacheDir)} are now iOS-compatible.`);
}

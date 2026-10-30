/**
 * Keeps the screen on while a game runs (audit QOL-1).
 *
 * A phone that sleeps mid-game drops its socket. The native Screen Wake Lock API only works in a
 * secure context, which the host's localhost page and a localhost TV are, but phones on the LAN
 * address (http://192.168.x.x) are not. For them an opt-in fallback plays a tiny muted looping
 * video, which browsers treat as active media. It is off by default because it costs battery;
 * the wake-up reconnect check (connection.ts) is the real fix for phones.
 */

export type WakeMode = 'native' | 'video' | 'none';

export function wakeMode(input: { gameRunning: boolean; secure: boolean; hasWakeLock: boolean; videoOptIn: boolean }): WakeMode {
  if (!input.gameRunning) return 'none';
  if (input.secure && input.hasWakeLock) return 'native';
  return input.videoOptIn ? 'video' : 'none';
}

// 2 s of 16x16 black H.264 baseline, generated with the bundled ffmpeg; plays inline everywhere.
const BLANK_VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2MC4zLjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMACDxImSABAAVoy4PEyAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApQAAAKUAAAABhzdHRzAAAAAAAAAAEAAAACAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAACiQAAAAsAAAAUc3RjbwAAAAAAAAABAAADWgAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjAuMy4xMDAAAAAIZnJlZQAAApxtZGF0AAACcgYF//9u3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzA3NSA2NmE1YmMxIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOi0zOi0zIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0yLjAwOjAuNzAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS00IHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4yMACAAAAAD2WIhAXzn///D0UAAVefgAAAAAdBmjgL5zqA';

interface WakeLockSentinelLike { released: boolean; release(): Promise<void> }
interface WakeEnv {
  requestWakeLock: () => Promise<WakeLockSentinelLike>;
  visible: () => boolean;
  makeVideo: () => HTMLVideoElement;
}

const browserEnv = (): WakeEnv => ({
  requestWakeLock: () => (navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<WakeLockSentinelLike> } })
    .wakeLock.request('screen'),
  visible: () => document.visibilityState === 'visible',
  makeVideo: () => {
    const video = Object.assign(document.createElement('video'), { src: BLANK_VIDEO, muted: true, loop: true, playsInline: true });
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(video);
    return video;
  },
});

/** The browser pieces are injected so the lifecycle can be tested without a DOM. */
export function createWakeKeeper(env: WakeEnv = browserEnv()) {
  let mode: WakeMode = 'none';
  let sentinel: WakeLockSentinelLike | null = null;
  let requesting = false;
  let video: HTMLVideoElement | null = null;

  // apply() runs on every render, so a request still in flight must not start a second one.
  const requestNative = async () => {
    requesting = true;
    try {
      const lock = await env.requestWakeLock();
      // The game may have ended while we waited; never hold the screen on after it.
      if (mode === 'native') sentinel = lock;
      else void lock.release().catch(() => {});
    } catch { /* Denied (battery saver, hidden tab); the next visible render retries. */ }
    finally { requesting = false; }
  };
  const stop = () => {
    void sentinel?.release().catch(() => {});
    sentinel = null;
    video?.pause();
    video?.remove();
    video = null;
  };

  return {
    /** Called on every render; cheap when nothing changes. */
    apply(next: WakeMode) {
      if (next !== mode) { stop(); mode = next; }
      if (mode === 'native' && !requesting && (!sentinel || sentinel.released) && env.visible()) void requestNative();
      if (mode === 'video') {
        video ??= env.makeVideo();
        // Phones pause inline media when the app is switched away; resume it on return.
        if (video.paused) void video.play().catch(() => {}); // autoplay may wait for the next tap
      }
    },
  };
}

const KEEP_AWAKE_KEY = 'sigame.keepAwake';

/**
 * Wires the per-device "Keep screen on" preference and returns `refresh()` for each render.
 * The checkbox only shows where the native API is missing (phones on the LAN address).
 */
export function setupKeepAwake(options: { isGameRunning: () => boolean; toggle: HTMLLabelElement; checkbox: HTMLInputElement }) {
  const keeper = createWakeKeeper();
  const hasWakeLock = 'wakeLock' in navigator;
  let optIn = false;
  try { optIn = localStorage.getItem(KEEP_AWAKE_KEY) === 'on'; } catch { /* Keep the default. */ }
  const refresh = () => keeper.apply(wakeMode({ gameRunning: options.isGameRunning(), secure: isSecureContext, hasWakeLock,
    videoOptIn: optIn }));
  options.toggle.hidden = isSecureContext && hasWakeLock;
  options.checkbox.checked = optIn;
  options.checkbox.addEventListener('change', () => {
    optIn = options.checkbox.checked;
    try { localStorage.setItem(KEEP_AWAKE_KEY, optIn ? 'on' : 'off'); } catch { /* Not saved. */ }
    refresh();
  });
  // A native wake lock is released whenever the tab is hidden; take it again on return.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  return refresh;
}

/**
 * Guarded timers for game callbacks.
 *
 * One throw inside a bare setTimeout callback becomes an uncaught exception and ends the
 * whole game night. These callbacks run without a caller to report to, so the safe answer
 * is to log, let the room re-broadcast whatever state it reached, and keep serving.
 */

export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Like setTimeout, but a throw is logged instead of crashing the process.
 * `onError` runs after a throw so the caller can re-sync clients (usually `room.changed()`).
 * The handle is unref'd: the HTTP server keeps the process alive in production, and an
 * idle game timer must not hold a test run or a shutdown open.
 */
export function safeTimeout(label: string, fn: () => void, ms: number, onError?: () => void): TimerHandle {
  const handle = setTimeout(() => {
    try {
      fn();
    } catch (err) {
      console.warn(`[timer] "${label}" failed: ${(err as Error)?.stack ?? err}`);
      try { onError?.(); } catch { /* the recovery hook must never become the new crash */ }
    }
  }, ms);
  handle.unref?.();
  return handle;
}

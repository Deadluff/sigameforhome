/**
 * When the launcher should restart a server that exited (audit CONN-1).
 *
 * Pure and CommonJS so the standalone executable's entry (`sea-entry.cjs`, plan wave 4) can
 * reuse it later; today only `start.js` supervises the server.
 * The rule: restart a crash, but never a deliberate stop, and give up on a crash loop.
 */
'use strict';

/** The server exits with this when its port is taken. Retrying cannot help. */
const EXIT_PORT_IN_USE = 78;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 3;

/**
 * @param {object} exit
 * @param {number | null} exit.status child exit code, null when it died by a signal
 * @param {string | null} exit.signal signal that killed the child, if any
 * @param {boolean} exit.parentStopping the launcher itself got SIGINT/SIGTERM. This also covers
 *   Windows Ctrl+C, where the child exits with 0xC000013A (3221225786) and no signal.
 * @param {number[]} exit.history timestamps of earlier restarts
 * @param {number} exit.now current time in ms
 * @returns {boolean}
 */
function shouldRestart({ status, signal, parentStopping, history = [], now = Date.now() }) {
  if (parentStopping) return false;
  // Someone killed the server on purpose (or the OS did); respawning would fight them.
  if (signal) return false;
  if (status === 0 || status === EXIT_PORT_IN_USE || status == null) return false;
  const recent = history.filter((at) => now - at < RESTART_WINDOW_MS);
  return recent.length < MAX_RESTARTS_IN_WINDOW;
}

module.exports = { shouldRestart, EXIT_PORT_IN_USE };

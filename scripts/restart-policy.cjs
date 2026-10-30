/**
 * When and how a launcher restarts a server that exited (audit CONN-1).
 *
 * CommonJS so both `start.js` and the standalone executable's entry (`sea-entry.cjs`, bundled by
 * esbuild) share one copy. The rule: restart a crash, but never a deliberate stop, and give up
 * on a crash loop.
 */
'use strict';

const { spawn } = require('node:child_process');

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

/**
 * Runs the server as a child process and restarts it per shouldRestart, then exits with its status.
 * Async spawn, not spawnSync: a parent blocked in spawnSync cannot see its own SIGINT/SIGTERM,
 * so it could not tell a deliberate stop from a crash.
 * @param {{ command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv }} options
 */
function supervise({ command, args, cwd, env }) {
  const isWindows = process.platform === 'win32';
  const restarts = [];
  let parentStopping = false;
  let child = null;

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      parentStopping = true;
      // POSIX: forward, so `kill <launcher>` also stops the server. A terminal Ctrl+C reaches both
      // processes; the server's shuttingDown guard ignores the duplicate.
      // Windows: do not forward. child.kill() terminates at once and skips the room-state save,
      // and a console Ctrl+C already reaches the child. Just wait for it to exit.
      if (!isWindows && child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  }

  const run = () => {
    if (parentStopping) process.exit(0);
    child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.on('error', (err) => {
      console.error(err);
      process.exit(1);
    });
    child.on('exit', (status, signal) => {
      const now = Date.now();
      if (shouldRestart({ status, signal, parentStopping, history: restarts, now })) {
        restarts.push(now);
        console.error(`\n  The server stopped unexpectedly (exit ${status}). Restarting; players can rejoin with their saved seats.\n`);
        setTimeout(run, 1000);
        return;
      }
      process.exit(status ?? 1);
    });
  };
  run();
}

module.exports = { shouldRestart, supervise, EXIT_PORT_IN_USE };

/** Install native dependencies for this machine, then start the local server. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRestart } from './restart-policy.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'node_modules');
const stamp = path.join(modules, '.sigame-install');
const lockfile = path.join(root, 'package-lock.json');
const commandSuffix = process.platform === 'win32' ? '.cmd' : '';
const buildTools = ['vite', 'tsc', 'tsx'].map((name) => path.join(modules, '.bin', `${name}${commandSuffix}`));

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18 || (nodeMajor === 18 && nodeMinor < 17)) {
  console.error('Node.js 18.17+ (or 20+ LTS) is required. Install it from https://nodejs.org.');
  process.exit(1);
}

// Native packages must be installed again if this checkout moves to another OS or CPU.
const fingerprint = [
  process.platform,
  process.arch,
  process.versions.modules,
  createHash('sha256').update(fs.readFileSync(path.join(root, 'package.json'))).digest('hex'),
  createHash('sha256').update(fs.readFileSync(lockfile)).digest('hex'),
].join(':');

if (!fs.existsSync(modules) || !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== fingerprint ||
    buildTools.some((tool) => !fs.existsSync(tool))) {
  console.log('Installing dependencies for this platform...');
  // npm selects the native binaries for the current OS and CPU.
  const install = spawnSync('npm', ['install', '--include=dev', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (install.error || install.status !== 0) {
    console.error(install.error ?? 'Dependency installation failed.');
    process.exit(install.status || 1);
  }
  fs.writeFileSync(stamp, fingerprint);
}

// The server serves Vite's output, so build the browser bundle before listening.
const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.error || build.status !== 0) {
  console.error(build.error ?? 'Client build failed.');
  process.exit(build.status || 1);
}

// Seed the same pack directory the server will read when PACKS_DIR is overridden.
const packsDir = path.resolve(root, process.env.PACKS_DIR ?? 'packs');
fs.mkdirSync(packsDir, { recursive: true });
if (!fs.readdirSync(packsDir).some((name) => name.toLowerCase().endsWith('.siq'))) {
  // A fresh install should be playable before the host downloads a pack.
  const sample = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts', 'make-sample-pack.ts')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (sample.error || sample.status !== 0) {
    console.error(sample.error ?? 'Sample pack generation failed.');
    process.exit(sample.status || 1);
  }
}
/*
 * Run the server under a small supervisor so one crash does not end the game night (audit CONN-1).
 * Async spawn, not spawnSync: a parent blocked in spawnSync cannot see its own SIGINT/SIGTERM,
 * so it could not tell a deliberate stop from a crash.
 */
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

function runServer() {
  if (parentStopping) process.exit(0);
  child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'server', 'index.ts')], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
  child.on('exit', (status, signal) => {
    const now = Date.now();
    if (shouldRestart({ status, signal, parentStopping, history: restarts, now })) {
      restarts.push(now);
      console.error(`\n  The server stopped unexpectedly (exit ${status}). Restarting; players can rejoin with their saved seats.\n`);
      setTimeout(runServer, 1000);
      return;
    }
    process.exit(status ?? 1);
  });
}

runServer();

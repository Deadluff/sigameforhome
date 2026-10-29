/** Install native dependencies for this machine, then start the local server. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const packsDir = path.join(root, 'packs');
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
const server = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'server', 'index.ts')], {
  cwd: root,
  stdio: 'inherit',
});
if (server.error) console.error(server.error);
process.exit(server.status ?? 1);

/** Build a native Node SEA containing the server, client, parser worker, and native tools. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const staging = path.join(out, 'sea-staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) throw new Error('Executable packaging requires Node.js 22 or newer');

await build({ entryPoints: [path.join(root, 'server/index.ts')], outfile: path.join(staging, 'server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['steamworks.js'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning' });
await build({ entryPoints: [path.join(root, 'server/packs/parseWorker.ts')], outfile: path.join(staging, 'parse-worker.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning' });
await build({ entryPoints: [path.join(root, 'server/steam/steamworksWorker.ts')], outfile: path.join(staging, 'steam-worker.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['steamworks.js'],
  logLevel: 'warning' });
// A SEA main script can only require built-ins, so bundle the entry with its shared restart policy.
await build({ entryPoints: [path.join(root, 'scripts/sea-entry.cjs')], outfile: path.join(staging, 'sea-entry.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' });

const files = new Map();
function add(name, source) {
  if (!fs.existsSync(source)) throw new Error(`Missing packaging asset: ${source}`);
  files.set(name, source);
}
function addTree(directory, prefix) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) addTree(full, `${prefix}/${entry.name}`);
    else if (entry.isFile()) add(`${prefix}/${entry.name}`, full);
  }
}
add('server.mjs', path.join(staging, 'server.mjs'));
add('parse-worker.mjs', path.join(staging, 'parse-worker.mjs'));
add('steam-worker.mjs', path.join(staging, 'steam-worker.mjs'));
addTree(path.join(root, 'client/dist'), 'client');
const demoDir = path.join(staging, 'demo');
fs.mkdirSync(demoDir, { recursive: true });
const demo = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/make-sample-pack.ts')],
  { cwd: root, env: { ...process.env, PACKS_DIR: demoDir }, stdio: 'inherit' });
if (demo.error || demo.status !== 0) throw demo.error ?? new Error('Demo pack generation failed');
addTree(demoDir, 'demo');
const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
add(`ffmpeg/${ffmpegName}`, path.join(root, 'node_modules/ffmpeg-static', ffmpegName));
add('ffmpeg/ffmpeg.LICENSE', path.join(root, 'node_modules/ffmpeg-static/ffmpeg.LICENSE'));
add('ffmpeg/ffmpeg.README', path.join(root, 'node_modules/ffmpeg-static/ffmpeg.README'));

const steamRoot = path.join(root, 'node_modules/steamworks.js');
const steamPlatform = process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'osx' : 'linux64';
add('steamworks.js/package.json', path.join(steamRoot, 'package.json'));
add('steamworks.js/index.js', path.join(steamRoot, 'index.js'));
add('steamworks.js/LICENSE', path.join(steamRoot, 'LICENSE'));
addTree(path.join(steamRoot, 'dist', steamPlatform), `steamworks.js/dist/${steamPlatform}`);

const hashes = Object.fromEntries([...files].map(([name, source]) =>
  [name, createHash('sha256').update(fs.readFileSync(source)).digest('hex')]));
const id = createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0, 16);
const manifest = path.join(staging, 'manifest.json');
fs.writeFileSync(manifest, JSON.stringify({ id, files: hashes }));
add('manifest.json', manifest);

const blob = path.join(staging, 'app.blob');
const seaConfig = path.join(staging, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(staging, 'sea-entry.cjs'), output: blob,
  disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
  assets: Object.fromEntries(files),
}));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited with ${result.status}`);
}
run(process.execPath, ['--experimental-sea-config', seaConfig]);
const executable = path.join(out, `sigame-local-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
if (process.platform === 'darwin') {
  // Universal Node binaries contain two SEA sentinels; inject into one architecture.
  run('lipo', ['-thin', process.arch === 'arm64' ? 'arm64' : 'x86_64', process.execPath, '-output', executable]);
  run('codesign', ['--remove-signature', executable]);
} else fs.copyFileSync(process.execPath, executable);
const postject = path.join(root, 'node_modules/postject/dist/cli.js');
const args = [postject, executable, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, args);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', executable]);
fs.chmodSync(executable, 0o755);
console.log(`Standalone executable: ${executable}`);

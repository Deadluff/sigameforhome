// Node SEA runs one CommonJS entry. Extract the bundled app once, then start it.
// build-exe.mjs bundles this file with esbuild, so it may require local modules.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sea = require('node:sea');
const { supervise } = require('./restart-policy.cjs');

function runtimeDir() {
  const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
  return { manifest, runtime: path.join(path.dirname(process.execPath), 'data', 'runtime', manifest.id) };
}

function extractRuntime(root, runtime, manifest) {
  for (const [name, digest] of Object.entries(manifest.files)) {
    const destination = path.join(runtime, name);
    // Verify cached executable code and native tools before loading them.
    const existing = fs.existsSync(destination) ? createHash('sha256').update(fs.readFileSync(destination)).digest('hex') : '';
    if (existing === digest) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(sea.getAsset(name)));
    // Windows cannot rename over an existing damaged extraction.
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  }
  fs.chmodSync(path.join(runtime, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), 0o755);
  const packs = path.resolve(process.env.PACKS_DIR ?? path.join(root, 'packs'));
  fs.mkdirSync(packs, { recursive: true });
  if (!fs.readdirSync(packs).some((name) => name.toLowerCase().endsWith('.siq'))) {
    for (const name of Object.keys(manifest.files).filter((item) => item.startsWith('demo/'))) {
      fs.copyFileSync(path.join(runtime, name), path.join(packs, path.basename(name)));
    }
  }
}

function setRuntimeEnv(root, runtime) {
  process.env.SIGAME_ROOT_DIR = root;
  process.env.PUBLIC_DIR ??= path.join(runtime, 'client');
  process.env.FFMPEG_BIN = path.join(runtime, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  process.env.SIGAME_PARSE_WORKER = path.join(runtime, 'parse-worker.mjs');
  process.env.SIGAME_STEAMWORKS_PATH = pathToFileURL(path.join(runtime, 'steamworks.js', 'index.js')).href;
  process.env.SIGAME_STEAM_WORKER_PATH = path.join(runtime, 'steam-worker.mjs');
}

async function main() {
  // The Steam worker is spawned by the server child and inherits SIGAME_SERVER_CHILD and the
  // runtime paths, so this check must come first or it would start a second server.
  if (process.env.SIGAME_STEAM_WORKER_MODE === '1') {
    await import(pathToFileURL(process.env.SIGAME_STEAM_WORKER_PATH).href);
    return;
  }
  const root = path.dirname(process.execPath);
  const { manifest, runtime } = runtimeDir();
  // Only the supervisor extracts and verifies; a restarted server skips re-hashing ffmpeg.
  if (process.env.SIGAME_RUNTIME_READY !== '1') extractRuntime(root, runtime, manifest);
  setRuntimeEnv(root, runtime);
  if (process.env.SIGAME_SERVER_CHILD === '1') {
    await import(pathToFileURL(path.join(runtime, 'server.mjs')).href);
    return;
  }
  // One crash should not end the game night: run the server as a child and restart it (audit CONN-1).
  supervise({ command: process.execPath, args: [],
    env: { ...process.env, SIGAME_SERVER_CHILD: '1', SIGAME_RUNTIME_READY: '1' } });
}

main().catch((error) => {
  console.error('Unable to start SIGame Local:', error);
  process.exitCode = 1;
});

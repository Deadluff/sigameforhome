// Node SEA runs one CommonJS entry. Extract the bundled app once, then start it.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sea = require('node:sea');

async function main() {
  const root = path.dirname(process.execPath);
  const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
  const runtime = path.join(root, 'data', 'runtime', manifest.id);
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
  const ffmpeg = path.join(runtime, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.chmodSync(ffmpeg, 0o755);
  process.env.SIGAME_ROOT_DIR = root;
  const packs = path.resolve(process.env.PACKS_DIR ?? path.join(root, 'packs'));
  fs.mkdirSync(packs, { recursive: true });
  if (!fs.readdirSync(packs).some((name) => name.toLowerCase().endsWith('.siq'))) {
    for (const name of Object.keys(manifest.files).filter((item) => item.startsWith('demo/'))) {
      fs.copyFileSync(path.join(runtime, name), path.join(packs, path.basename(name)));
    }
  }
  process.env.PUBLIC_DIR ??= path.join(runtime, 'client');
  process.env.FFMPEG_BIN = ffmpeg;
  process.env.SIGAME_PARSE_WORKER = path.join(runtime, 'parse-worker.mjs');
  process.env.SIGAME_STEAMWORKS_PATH = pathToFileURL(path.join(runtime, 'steamworks.js', 'index.js')).href;
  process.env.SIGAME_STEAM_WORKER_PATH = path.join(runtime, 'steam-worker.mjs');
  if (process.env.SIGAME_STEAM_WORKER_MODE === '1') {
    await import(pathToFileURL(process.env.SIGAME_STEAM_WORKER_PATH).href);
    return;
  }
  await import(pathToFileURL(path.join(runtime, 'server.mjs')).href);
}

main().catch((error) => {
  console.error('Unable to start SIGame Local:', error);
  process.exitCode = 1;
});

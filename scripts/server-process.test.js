/** The real server process: removed routes, clean shutdown, and the port-in-use exit code. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-server-process-'));
after(async () => fsp.rm(temp, { recursive: true, force: true }));

async function freePort() {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

function startServer(port) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'server', 'index.ts')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
      PACKS_DIR: path.join(temp, 'packs'), CACHE_DIR: path.join(temp, 'cache'),
      ROOM_STATE_FILE: path.join(temp, `room-${port}.json`) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (output.includes('server is running')) resolve(); });
    exited.then(([code]) => reject(new Error(`server exited early (${code}): ${output}`)));
  });
  return { child, ready, exited, output: () => output };
}

test('GET /api/packs is gone, and SIGTERM shuts down cleanly', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const server = startServer(port);
  await server.ready;
  const res = await fetch(`http://127.0.0.1:${port}/api/packs`);
  assert.equal(res.status, 404);
  const info = await fetch(`http://127.0.0.1:${port}/api/info`);
  assert.equal(info.status, 200);

  server.child.kill('SIGTERM');
  const [code, signal] = await server.exited;
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.match(server.output(), /Shutting down/);
});

test('a taken port exits with code 78 so the launcher does not retry', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const blocker = net.createServer().listen(port, '127.0.0.1');
  await once(blocker, 'listening');
  try {
    const server = startServer(port);
    server.ready.catch(() => {});
    const [code] = await server.exited;
    assert.equal(code, 78);
    assert.match(server.output(), /already in use/);
  } finally {
    blocker.close();
  }
});

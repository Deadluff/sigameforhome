/** Anti-framing headers and error replies (audits SEC-7, SEC-8). */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { errorHandler, originMiddleware, securityHeaders } from '../server/http/httpSafety.ts';
import { policyFromEnv } from '../server/socket/originGuard.ts';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-http-'));
await fsp.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
await fsp.writeFile(path.join(dir, '.secret'), 'nope');
await fsp.writeFile(path.join(dir, 'page.html'), '<p>media html</p>');

// Mirrors server/index.ts: guard and headers first, media with its own CSP, the app shell, then errors.
const app = express();
app.use(originMiddleware(policyFromEnv({}, 'studio-mac')));
app.use(securityHeaders);
app.use('/media-html/ticket', express.static(dir, {
  fallthrough: false, dotfiles: 'deny', index: false,
  setHeaders: (res) => res.setHeader('Content-Security-Policy', 'sandbox allow-same-origin'),
}));
app.get('/boom', () => { throw new Error(`failed reading ${dir}/private/file.json`); });
app.use(express.static(dir, { index: 'index.html' }));
app.use(errorHandler);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.close(); await fsp.rm(dir, { recursive: true, force: true }); });

test('the app shell cannot be framed by other sites', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('media HTML stays framable by the game itself', async () => {
  const res = await fetch(`${base}/media-html/ticket/page.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.doesNotMatch(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});

test('a dotfile is a 403 with an error body, not a 500', async () => {
  const res = await fetch(`${base}/media-html/ticket/.secret`);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'Forbidden' });
});

test('a server error never echoes paths to the client', async (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const res = await fetch(`${base}/boom`);
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.equal(body, JSON.stringify({ error: 'Server error' }));
  assert.ok(!body.includes(dir));
  assert.equal(quiet.mock.callCount(), 1, 'the real error is still logged on the server');
});

test('a foreign Host is refused before any route runs', async () => {
  // fetch() drops a custom Host header, so use node:http to send what a rebinding page would.
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); })
      .on('error', reject);
  });
  assert.equal(status, 403);
});

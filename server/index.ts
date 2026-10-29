/**
 * Entry point: Express (static client + on-the-fly TS transpilation + REST + pack media)
 * and Socket.io on one port.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { transform } from 'esbuild';
import express, { type NextFunction, type Request, type Response } from 'express';
import qrcode from 'qrcode-terminal';
import { Server } from 'socket.io';
import { config } from './config.ts';
import { Room } from './game/Room.ts';
import { ensureIosCompatibleMedia } from './packs/mediaTranscoder.ts';
import { listPacks } from './packs/packManager.ts';
import { registerSocketHandlers } from './socket/handlers.ts';
import { ensureDir, pathExists, safeJoin } from './utils/fsx.ts';
import { getLanAddresses } from './utils/network.ts';

await Promise.all([ensureDir(config.packsDir), ensureDir(config.cacheDir)]);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10_000,
  pingTimeout: 8_000,
  maxHttpBufferSize: 1e6,
});

const room = new Room();
registerSocketHandlers(io, room);

/* ------------------------------------------------------------------ HTTP */

app.disable('x-powered-by');

app.get('/api/info', (_req: Request, res: Response) => {
  res.json({
    port: config.port,
    urls: getLanAddresses().map((a) => `http://${a.address}:${config.port}`),
  });
});

app.get('/api/packs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listPacks());
  } catch (err) {
    next(err);
  }
});

/**
 *Extracted pack media: /media/<packId>/Images/foo.jpg (supports range requests for audio/video).
 * Before serving video/audio, ensures the file is transcoded to H.264/AAC (MP4) or MP3
 * so iPhone & iPad Safari can play packs encoded with AV1/VP9/Opus.
 */
app.use('/media', async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const decoded = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    if (decoded.length >= 2) {
      const folder = decoded[1].toLowerCase();
      if (folder === 'video' || folder === 'audio') {
        const filePath = safeJoin(config.cacheDir, ...decoded);
        await ensureIosCompatibleMedia(filePath);
      }
    }
  } catch {
    /* let express.static handle 404 / invalid paths */
  }
  next();
});

app.use(
  '/media',
  express.static(config.cacheDir, { fallthrough: false, maxAge: '1h', dotfiles: 'deny', index: false }),
);

/**
 * Zero-build Frontend TypeScript Middleware (Option B):
 * Compiles any requested `/*.ts` (or `/*.js` backed by a `.ts` file in `public/`) on the fly
 * in ~2ms using esbuild's in-memory transform, cached by file mtime.
 */
const tsCompileCache = new Map<string, { mtimeMs: number; code: string }>();

app.use(async (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!req.path.endsWith('.ts') && !req.path.endsWith('.js')) return next();

  try {
    const relPath = req.path.replace(/^\/+/, '').replace(/\.js$/, '.ts');
    const tsFilePath = safeJoin(config.publicDir, relPath);
    if (!(await pathExists(tsFilePath))) return next();

    const stat = await fsp.stat(tsFilePath);
    let cached = tsCompileCache.get(tsFilePath);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      const source = await fsp.readFile(tsFilePath, 'utf8');
      const result = await transform(source, {
        loader: 'ts',
        target: 'es2020',
        format: 'esm',
        sourcemap: 'inline',
        sourcefile: path.basename(tsFilePath),
      });
      cached = { mtimeMs: stat.mtimeMs, code: result.code };
      tsCompileCache.set(tsFilePath, cached);
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(cached.code);
  } catch (err) {
    next(err);
  }
});

/** Static web client assets (index.html, style.css, etc.). */
if (fs.existsSync(config.publicDir)) {
  app.use(express.static(config.publicDir, { index: 'index.html' }));
}

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.status === 404) return res.status(404).end();
  console.error(err);
  res.status(500).json({ error: err.message });
});

/* --------------------------------------------------------------- startup */

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Close the other app or run: set PORT=3001 && start.bat\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const addresses = getLanAddresses();
  const best = addresses[0] ? `http://${addresses[0].address}:${config.port}` : null;

  console.log('\n  ==============================================');
  console.log('   SIGame Local server is running (TypeScript)');
  console.log('  ==============================================\n');
  console.log(`   On this PC:      http://localhost:${config.port}`);
  for (const a of addresses) {
    const note = a.likelyVirtual ? '  (virtual adapter - probably not this one)' : '';
    console.log(`   On your network: http://${a.address}:${config.port}   [${a.iface}]${note}`);
  }
  if (!addresses.length) console.log('   No network adapter found - only this PC can connect.');
  console.log(`\n   Packs folder:    ${config.packsDir}`);
  console.log('   First person to join chooses Host or Player.\n');

  if (best) {
    console.log('   Scan to join:');
    qrcode.generate(best, { small: true }, (qr: string) => console.log(qr.replace(/^/gm, '   ')));
  }
  console.log('   If phones cannot connect, allow Node.js through Windows Firewall (Private networks).\n');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\n  Shutting down...');
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

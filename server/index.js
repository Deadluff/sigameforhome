/**
 * Entry point: Express (static client + REST + pack media) and Socket.io on one port.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import qrcode from 'qrcode-terminal';
import { Server } from 'socket.io';
import { config } from './config.js';
import { Room } from './game/Room.js';
import { persistRoom, restoreRoom } from './game/persistence.js';
import { ensureIosCompatibleMedia } from './packs/mediaTranscoder.js';
import { listPacks } from './packs/packManager.js';
import { canUpload, MAX_UPLOAD_BYTES, saveUploadedPack, UploadError } from './packs/upload.js';
import { registerSocketHandlers } from './socket/handlers.js';
import { ensureDir, safeJoin } from './utils/fsx.js';
import { getLanAddresses } from './utils/network.js';

await Promise.all([ensureDir(config.packsDir), ensureDir(config.cacheDir)]);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Mobile browsers on flaky Wi-Fi: detect dead sockets reasonably fast.
  pingInterval: 10_000,
  pingTimeout: 8_000,
  maxHttpBufferSize: 1e6,
});

const room = new Room();
await restoreRoom(room);
const flushRoomState = persistRoom(room);
registerSocketHandlers(io, room);

/* ------------------------------------------------------------------ HTTP */

app.disable('x-powered-by');

/** Basic info for the client (e.g. to show the join link / QR on the host screen). */
app.get('/api/info', (_req, res) => {
  res.json({
    port: config.port,
    urls: getLanAddresses().map((a) => `http://${a.address}:${config.port}`),
  });
});

app.get('/api/packs', async (_req, res, next) => {
  try {
    res.json(await listPacks());
  } catch (err) {
    next(err);
  }
});

/** Hosts and room owners may add a pack without exposing an unfinished archive to players. */
app.post('/api/packs/upload', async (req, res) => {
  if (!canUpload(room, req.headers.authorization)) return res.status(403).json({ error: 'Only a connected host or owner may upload packs' });
  if (!req.is('application/octet-stream')) return res.status(415).json({ error: 'Upload a .siq file as application/octet-stream' });
  if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Pack exceeds the 200 MB limit' });
  try {
    const result = await saveUploadedPack(req, req.headers['x-pack-name']);
    res.status(201).json(result);
    listPacks().then((packs) => {
      for (const socket of io.sockets.sockets.values()) {
        if (room.canManage(socket.data.pid)) socket.emit('packs:changed', { packs });
      }
    }).catch((err) => console.warn(`[packs] Refresh after upload failed: ${err.message}`));
  } catch (err) {
    if (err instanceof UploadError) return res.status(err.status).json({ error: err.message });
    console.error('[packs] Upload failed:', err);
    res.status(500).json({ error: 'Pack upload failed' });
  }
});

/**
 * Extracted pack media: /media/<packId>/Images/foo.jpg (supports range requests for audio/video).
 * Before serving video/audio, ensures the file is transcoded to H.264/AAC (MP4) or MP3
 * so iPhone & iPad Safari can play packs encoded with AV1/VP9/Opus.
 */
app.use('/media', (req, res, next) => {
  if (!room.canAccessMedia(req.query.ticket, `/media${req.path}`)) return res.status(403).end();
  next();
});

app.use('/media', async (req, res, next) => {
  try {
    const decoded = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    if (decoded.length >= 2) {
      const folder = decoded[1].toLowerCase();
      if (folder === 'video' || folder === 'audio') {
        const filePath = safeJoin(config.cacheDir, ...decoded);
        const packCacheDir = safeJoin(config.cacheDir, decoded[0]);
        const playable = await ensureIosCompatibleMedia(filePath, packCacheDir);
        if (playable !== filePath) {
          // Redirect to the derivative so Express supplies the correct media MIME type.
          const relative = path.relative(config.cacheDir, playable).split(path.sep).map(encodeURIComponent).join('/');
          return res.redirect(307, `/media/${relative}?ticket=${encodeURIComponent(req.query.ticket)}`);
        }
      }
    }
  } catch {
    /* let express.static handle 404 / invalid paths */
  }
  next();
});

app.use(
  '/media',
  express.static(config.cacheDir, {
    fallthrough: false, dotfiles: 'deny', index: false,
    // Pack-authored HTML/SVG must not execute in the app's origin when opened directly.
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
    },
  }),
);

/** Web client. */
if (fs.existsSync(config.publicDir)) {
  app.use(express.static(config.publicDir, { index: 'index.html' }));
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.status === 404) return res.status(404).end();
  console.error(err);
  res.status(500).json({ error: err.message });
});

/* --------------------------------------------------------------- startup */

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Close the other app or set PORT=3001 before starting again.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const addresses = getLanAddresses();
  const best = addresses[0] ? `http://${addresses[0].address}:${config.port}` : null;

  console.log('\n  ==============================================');
  console.log('   SIGame Local server is running');
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
    qrcode.generate(best, { small: true }, (qr) => console.log(qr.replace(/^/gm, '   ')));
  }
  console.log('   If phones cannot connect, allow Node.js through your firewall.\n');
});

/* Graceful shutdown on Ctrl+C. */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  Shutting down...');
    io.close();
    const finish = async () => {
      await flushRoomState();
      process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 2000).unref();
  });
}

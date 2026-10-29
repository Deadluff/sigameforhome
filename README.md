# SIGame Local

A self-hosted, LAN-only Jeopardy-style game for a room full of phones, inspired by
[SIGame](https://github.com/VladimirKhil/SI) / [SIOnline](https://github.com/VladimirKhil/SIOnline).
One Windows PC runs the server. Everyone else opens the link in a browser.

## Quick start (Windows)

1. Install **Node.js 18+ LTS** from https://nodejs.org.
2. Double-click **`start.bat`**. On the first run it installs dependencies.
3. The console shows `http://192.168.x.x:3000` plus a QR code. Share either one with your players.
4. The **first person to join** chooses **Host** or **Player**. Everyone after that becomes a Player,
   or a Spectator once the player slots are full.
5. Put `.siq` packs in `packs/`, or paste a Steam Workshop link in the host panel.

> Windows Firewall asks for permission the first time you run it. Allow **Private networks**,
> otherwise phones can't connect. To use a different port: `set PORT=3001` then `start.bat`.

## Quick start (macOS)

1. Install **Node.js 18+ LTS** from https://nodejs.org (or via Homebrew: `brew install node`).
2. Double-click **`start.command`** in Finder, or run **`./start.sh`** in Terminal:
   ```bash
   chmod +x start.sh start.command
   ./start.sh
   ```
   *(If macOS Gatekeeper blocks double-clicking `start.command` after cloning/downloading, either Right-Click → **Open**, or run `xattr -d com.apple.quarantine start.command start.sh` once in Terminal).*
3. On the first run it installs dependencies, creates demo packs if `packs/` is empty, and prints your Mac's LAN link (`http://192.168.x.x:3000`) + a QR code for phones. To use a different port: `PORT=3001 ./start.sh`.

Want a pack to test with? Run `npm run make-sample` to create two demo packs (modern v5 format and legacy v4 format).

## Project structure

```
sigamelocal/
├─ start.bat                 Windows launcher (checks Node, installs deps, runs tsx server/index.ts)
├─ start.sh / start.command  macOS / Linux launchers
├─ tsconfig.json             Strict zero-emit TypeScript config (checks server/, public/, scripts/)
├─ package.json
├─ server/
│  ├─ index.ts               Express + Socket.io + on-the-fly esbuild TS middleware for public/*.ts
│  ├─ config.ts              Typed paths, port, Steam app id (env-overridable)
│  ├─ game/
│  │  ├─ constants.ts        ROLES, PHASES, Role/Phase union types
│  │  ├─ settings.ts         GameSettings interface + schema based on SIGame's AppSettings/TimeSettings
│  │  ├─ Room.ts             Participants, sessions/reconnect, role assignment, RoomSnapshot type
│  │  └─ GameEngine.ts       Board → reading → buzzer → answering → reveal state machine
│  ├─ socket/handlers.ts     Typed Socket.io event API + permission checks
│  ├─ packs/
│  │  ├─ siqParser.ts        .siq (zip + content.xml v4/v5) → Package model, safe media extraction
│  │  ├─ mediaTranscoder.ts  Automatic AV1/VP9/Opus → H.264/AAC transcoding for iPhone/iPad
│  │  └─ packManager.ts      List, load and cache packs
│  ├─ steam/
│  │  ├─ workshop.ts         Link → id → Steam API → local Steam / Steamworks UGC / steamcmd → .siq
│  │  ├─ localSteam.ts       Local Steam library scanner + Steamworks UGC downloader
│  │  └─ steamcmd.ts         Installs steamcmd automatically and runs workshop_download_item
│  └─ utils/                 Network (LAN IPs), filesystem helpers (.ts)
├─ public/
│  ├─ index.html             Loads <script type="module" src="app.ts">
│  ├─ app.ts                 Frontend TypeScript (imports RoomSnapshot type directly from server/)
│  └─ style.css
├─ scripts/                  inspect-pack.ts, make-sample-pack.ts, smoke-test.ts
├─ packs/                    Your .siq files
├─ data/cache/               Extracted & iOS-transcoded media (safe to delete)
└─ tools/steamcmd/           Created if the steamcmd fallback is used
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Start the TypeScript server directly via `tsx` (no build step) |
| `npm run dev` | Start with auto-restart on `.ts` file changes |
| `npm run typecheck` | Run `tsc --noEmit` across `server/`, `public/`, and `scripts/` |
| `npm run make-sample` | Create demo packs in `packs/` |
| `npm run inspect-pack -- packs/X.siq [--json]` | Print a pack summary, or the full parsed model with `--json` |
| `npm run smoke` | End-to-end test against a running, freshly started server |

## Socket API (summary)

Every client event is `(payload, ack)`. The ack returns `{ ok: true, ... }` or `{ ok: false, error }`.

| Event | Who | Payload |
|---|---|---|
| `session:join` / `session:resume` | anyone | `{ nickname }` / `{ token }` |
| `role:choose` | first joiner | `{ role: 'host' \| 'player' }` |
| `role:set` | self / host | `{ targetId, role }` |
| `packs:list`, `packs:load`, `steam:download` | host/owner | `{ file }`, `{ link }` |
| `settings:schema`, `settings:update` | anyone / host/owner | patch object |
| `game:start`, `game:stop`, `game:select`, `game:openBuzzer`, `game:buzz`, `game:judge`, `game:reveal`, `game:next`, `game:nextRound` | as appropriate | |

Server → client: `room:state` (a personalised snapshot; players never get answers early), `game:event`,
`steam:progress`, `packs:changed`, `session:kicked`.

## Roadmap

- [x] Step 1: project setup, Windows launcher
- [x] Step 2: server, role assignment, sessions/reconnect, core game loop
- [x] Step 3: `.siq` parser (v4 and v5 formats)
- [x] Step 4: Steam Workshop downloader
- [ ] Step 5: React + Vite client (host dashboard, player buzzer, big-screen "TV" view)
- [ ] Step 6: special questions (secret/"cat in a poke", stake/auction, no-risk, for-all), final round
- [ ] Step 7: appeals, pause/resume, pack upload from the browser, sounds, packaging as a single .exe

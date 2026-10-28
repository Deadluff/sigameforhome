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

Want a pack to test with? Run `npm run make-sample` to create two demo packs (modern v5 format and legacy v4 format).

## Project structure

```
sigamelocal/
├─ start.bat                 Windows launcher (checks Node, installs deps, starts server)
├─ package.json
├─ server/
│  ├─ index.js               Express + Socket.io bootstrap, prints the LAN link and QR code
│  ├─ config.js              Paths, port, Steam app id (env-overridable)
│  ├─ game/
│  │  ├─ constants.js        ROLES, PHASES
│  │  ├─ settings.js         Settings schema based on SIGame's AppSettings/TimeSettings
│  │  ├─ Room.js             Participants, sessions/reconnect, role assignment, ownership
│  │  └─ GameEngine.js       Board → reading → buzzer → answering → reveal state machine
│  ├─ socket/handlers.js     Socket event API + permission checks
│  ├─ packs/
│  │  ├─ siqParser.js        .siq (zip + content.xml v4/v5) → normalised model, safe media extraction
│  │  └─ packManager.js      List, load and cache packs
│  ├─ steam/
│  │  ├─ workshop.js         Link → id → Steam API → direct download or steamcmd → .siq in packs/
│  │  └─ steamcmd.js         Installs steamcmd automatically and runs workshop_download_item
│  └─ utils/                 Network (LAN IPs), filesystem helpers
├─ public/                   Temporary vanilla JS dev client (React client comes in Step 5)
├─ scripts/                  inspect-pack, make-sample-pack, smoke-test
├─ packs/                    Your .siq files
├─ data/cache/               Extracted media (safe to delete)
└─ tools/steamcmd/           Created the first time you download from the Workshop
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with auto-restart on file changes |
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

# SIGame Local

A self-hosted, LAN-only Jeopardy-style game for a room full of phones, inspired by
[SIGame](https://github.com/VladimirKhil/SI) / [SIOnline](https://github.com/VladimirKhil/SIOnline).
One Windows, macOS, or Linux computer runs the server. Everyone else opens the link in a browser.
The browser client uses strict TypeScript and pinned Rolldown Vite 7 for Rust-backed bundling.

## Quick start

1. Install **Node.js 20.19+ or 22.12+** from https://nodejs.org.
2. On Windows, double-click **`start.bat`**. On macOS or Linux, run **`./start.sh`**. You can also run **`npm start`** on any platform. The launcher installs dependencies for the current OS and CPU when needed, builds the TypeScript/Vite client, then starts the server.
3. The console shows `http://192.168.x.x:3000` plus a QR code. Share either one with your players.
4. The **first person to join** chooses **Host** or **Player**. Everyone after that becomes a Player,
   or a Spectator once the player slots are full.
   If the first person chooses Player, appoint another participant as Host in the lobby before starting.
   If the host disconnects during play, a connected player inherits moderation after the reconnect
   window. They can release the offline host seat and appoint a connected spectator as host.
5. In the host panel, upload a `.siq` pack or paste a Steam Workshop link. You can also put packs in `packs/`.

Open `http://<server-address>:3000/?tv` on a shared screen after a participant joins. It joins as a spectator.
Room seats, scores, settings, and the board are saved under `data/room-state.json` for restart recovery.
An interrupted question returns to the board for replay after restart.
The host can pause and resume the current phase; question media and round countdowns pause with it.
Pack media URLs carry a viewer ticket; the server only serves the current question and
revealed answer media to players. Keep room links within the local network.
Pack uploads are limited to 200 MB, validated before they appear in the list, and require a connected host or room owner.
Workshop updates keep prior pack versions so a saved game can resume with the same questions after a restart.

Guided classic mode supports standard, no-risk, secret, secret gifts without a question, stake auctions, for-all questions, and final questions.
In a stake auction, players bid in turn, may go all-in or pass, and the high bidder answers for the winning amount.
For-all questions collect each player's private text answer, then the host judges them separately for the fixed question value.
The host selects secret recipients. In the final round, players submit private wagers and the host
judges each answer. Final themes are removed one by one before the question is chosen. The optional
“Play all final themes” setting repeats this flow for the first question of every final theme.
After a revealed verdict, players can request an appeal. Eligible players vote privately; an accepted appeal
corrects the score and, when needed, the next chooser.
Pack files are limited to 200 MB compressed and 1 GB extracted.

> Allow Node.js through your firewall so phones can connect. To use a different port,
> set `PORT=3001` before starting (`set PORT=3001` on Windows, `PORT=3001 ./start.sh` on macOS/Linux).

Want a pack to test with? Run `npm run make-sample` to create two demo packs (modern v5 format and legacy v4 format).

## Project structure

```
sigamelocal/
├─ start.bat / start.sh      Platform entry points
├─ scripts/start.js          Shared installer and server launcher
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
├─ client/                   TypeScript browser client and Vite build output
├─ vite.config.ts            Vite build and development proxy
├─ scripts/                  inspect-pack, make-sample-pack, smoke-test
├─ packs/                    Your .siq files
├─ data/cache/               Extracted media (safe to delete)
└─ tools/steamcmd/           Created the first time you download from the Workshop
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Install platform dependencies if needed, then start the server |
| `npm run dev` | Build the client, then auto-restart the server on changes |
| `npm run dev:client` | Vite client dev server on port 5173; proxies sockets and media to the server on port 3000 |
| `npm run build` | Type-check and bundle the client into `client/dist` |
| `npm run make-sample` | Create demo packs in `packs/` |
| `npm run inspect-pack -- packs/X.siq [--json]` | Print a pack summary, or the full parsed model with `--json` |
| `npm run smoke` | End-to-end test against a running, freshly started server |
| `npm test` | Isolated answer privacy, media access, host recovery, game-rule, and restart tests |

For client changes, run `npm run dev` and `npm run dev:client` in separate terminals, then open
port 5173. If the server uses another `PORT`, set the same value for `dev:client`.

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
| `game:stakeBid`, `game:stakePass` | current bidder | `{ amount, allIn }`, `{}` |
| `game:forAllAnswer`, `game:closeForAll`, `game:judgeForAll` | player / host / host | `{ answer }`, `{}`, `{ playerId, correct }` |
| `game:appealRequest`, `game:appealVote`, `game:appealClose` | player / eligible voter / host | `{ judgmentId }`, `{ support }`, `{}` |

Server → client: `room:state` (a personalised snapshot; players never get answers early), `game:event`,
`steam:progress`, `packs:changed`, `session:kicked`.

The host panel uploads packs with `POST /api/packs/upload` using the room session token in an
`Authorization: Bearer` header and a URI-encoded filename in `X-Pack-Name`.

## Roadmap

- [x] Step 1: project setup, cross-platform launcher
- [x] Step 2: server, role assignment, sessions/reconnect, core game loop
- [x] Step 3: `.siq` parser (v4 and v5 formats)
- [x] Step 4: Steam Workshop downloader
- [x] Step 5: TypeScript + Vite client (host dashboard, player buzzer, big-screen "TV" view)
- [x] Step 6: special questions (secret/"cat in a poke", stake/auction, no-risk, for-all), final round
- [x] Step 7: pause/resume, browser pack upload, sound cues
- [x] Step 7: appeals
- [ ] Remaining: single-executable packaging

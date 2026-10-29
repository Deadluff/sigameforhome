/**
 * End-to-end smoke test against a running server:
 *   npm run smoke
 * Simulates a host and two players: role assignment, pack load, false start, buzz, judging,
 * media serving, and on-the-fly TypeScript transpilation of /app.ts.
 */
import { io, type Socket } from 'socket.io-client';
import type { RoomSnapshot } from '../server/game/Room.ts';

const URL = process.env.URL ?? 'http://localhost:3000';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TestClient {
  name: string;
  socket: Socket;
  state: RoomSnapshot;
  emit(event: string, payload?: unknown): Promise<Record<string, any>>;
}

function client(name: string): TestClient {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const c: TestClient = {
    name,
    socket,
    state: null as unknown as RoomSnapshot,
    emit: (event: string, payload: unknown = {}) =>
      new Promise((resolve) => socket.emit(event, payload, resolve)),
  };
  socket.on('room:state', (s: RoomSnapshot) => {
    c.state = s;
  });
  return c;
}

function check(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`✘ ${msg}`);
    process.exit(1);
  }
  console.log(`✔ ${msg}`);
}

// Verify that the server transpiles /app.ts on the fly to JavaScript
const appTsRes = await fetch(`${URL}/app.ts`);
const appTsCode = await appTsRes.text();
check(
  appTsRes.ok &&
    (appTsRes.headers.get('content-type') ?? '').includes('javascript') &&
    !appTsCode.includes('interface SocketAckResponse'),
  'on-the-fly /app.ts transpilation serves clean JS to browser',
);

const host = client('Alice');
const p1 = client('Bob');
const p2 = client('Carol');

let r = await host.emit('session:join', { nickname: 'Alice' });
check(r.ok && r.role === 'pending', 'first joiner gets the Host/Player choice');

r = await p1.emit('session:join', { nickname: 'Bob' });
check(r.ok && r.role === 'player', 'second joiner is auto-assigned player');
const bobToken = r.token as string;

r = await p2.emit('session:join', { nickname: 'bob' });
check(!r.ok, 'duplicate nickname (case-insensitive) rejected');
r = await p2.emit('session:join', { nickname: 'Carol' });
check(r.ok && r.role === 'player', 'third joiner is player');

r = await p1.emit('role:choose', { role: 'host' });
check(!r.ok, 'non-first participant cannot use the initial role choice');

r = await host.emit('role:choose', { role: 'host' });
check(r.ok, 'first joiner chose Host');

r = await p1.emit('packs:list');
check(!r.ok, 'players cannot manage packs');

r = await host.emit('packs:list');
check(r.ok && r.packs.length > 0, `host lists packs (${r.packs?.length})`);
const demo = r.packs.find((p: { name: string }) => p.name.includes('v5')) ?? r.packs[0];

r = await host.emit('packs:load', { file: demo.file });
check(r.ok, `pack loaded: ${demo.name}`);

r = await host.emit('game:start');
await sleep(50);
check(r.ok && host.state.game.phase === 'board', 'game started, board shown');

r = await host.emit('game:select', { themeIndex: 0, questionIndex: 1 });
await sleep(50);
check(r.ok && host.state.game.phase === 'reading', 'host selected a question → reading');
check((host.state.game.current?.right?.length ?? 0) > 0, 'host sees the answer');
check(p1.state.game.current?.right === null, 'players do NOT see the answer');

const img = p1.state.game.current?.content.find((i) => i.type === 'image');
if (img?.url) {
  const res = await fetch(URL + img.url);
  check(res.ok && (res.headers.get('content-type') ?? '').includes('image'), `media served: ${img.url}`);
}

r = await p1.emit('game:buzz');
check(r.result === 'falseStart', `pressing during reading = false start (${JSON.stringify(r)})`);

r = await host.emit('game:openBuzzer');
await sleep(20);
r = await p1.emit('game:buzz');
check(r.result === 'ignored', 'false-started player is still blocked');
r = await p2.emit('game:buzz');
await sleep(150);
check(
  host.state.game.phase === 'answering' && host.state.game.buzzer.winnerId === p2.state.you?.id,
  'Carol won the buzzer',
);

r = await host.emit('game:judge', { correct: false });
await sleep(50);
const price = host.state.game.current!.price;
check(host.state.participants.find((p) => p.name === 'Carol')?.score === -price, 'wrong answer subtracts the price');
check(host.state.game.phase === 'buzzerOpen', 'buttons reopen for remaining players');

await sleep(3100);
r = await p1.emit('game:buzz');
await sleep(150);
r = await host.emit('game:judge', { correct: true });
await sleep(50);
check(host.state.participants.find((p) => p.name === 'Bob')?.score === price, 'correct answer adds the price');
check((p1.state.game.current?.right?.length ?? 0) > 0, 'answer revealed to players');

r = await host.emit('game:next');
await sleep(50);
check(
  host.state.game.phase === 'board' && host.state.game.chooserId === p1.state.you?.id,
  'back to board, Bob chooses next',
);

const bobId = p1.state.you!.id;
p1.socket.close();
await sleep(100);
check(host.state.participants.find((p) => p.id === bobId)?.connected === false, 'Bob shown as disconnected');
const bob2 = client('Bob (reconnected)');
r = await bob2.emit('session:resume', { token: bobToken });
await sleep(50);
check(r.resumed && bob2.state.you?.id === bobId && bob2.state.you?.role === 'player', 'Bob resumed his seat');
check(bob2.state.participants.find((p) => p.id === bobId)?.score === price, 'score preserved after reconnect');

r = await host.emit('settings:update', { falseStart: false });
await sleep(30);
check(r.ok && host.state.settings.falseStart === false, 'host disabled falseStart (фальшстарт OFF)');
r = await bob2.emit('game:select', { themeIndex: 0, questionIndex: 0 });
await sleep(40);
check(r.ok && host.state.game.phase === 'buzzerOpen', 'with falseStart OFF, question goes directly to buzzerOpen');
r = await bob2.emit('game:buzz');
await sleep(50);
check(r.result === 'accepted' && host.state.game.phase === 'answering', 'player can buzz immediately during reading when falseStart is OFF');

await host.emit('game:reveal');
await host.emit('game:next');
await sleep(30);

const pingRes = await bob2.emit('clock:ping');
check(pingRes.ok && typeof pingRes.serverTime === 'number', 'clock:ping returns serverTime for NTP calibration');

r = await host.emit('settings:update', { buzzSyncMode: 'clientTimestamp', buzzSyncWindowMs: 120 });
await sleep(30);
check(r.ok && host.state.settings.buzzSyncMode === 'clientTimestamp', 'host switched buzzSyncMode to clientTimestamp');

await host.emit('game:select', { themeIndex: 0, questionIndex: 2 });
await sleep(30);
const tOpen = Date.now();
const pCarolBuzz = p2.emit('game:buzz', { clientAt: tOpen + 60 });
await sleep(30);
const pBobBuzz = bob2.emit('game:buzz', { clientAt: tOpen + 15 });
await Promise.all([pCarolBuzz, pBobBuzz]);
await sleep(160);
check(
  host.state.game.phase === 'answering' &&
    host.state.game.buzzer.winnerId === bobId &&
    host.state.game.buzzer.winnerInfo?.mode === 'clientTimestamp',
  'clientTimestamp mode picks player who clicked earlier despite packet arriving later',
);

for (const c of [host, p2, bob2]) c.socket.close();
console.log('\nAll checks passed.');
process.exit(0);

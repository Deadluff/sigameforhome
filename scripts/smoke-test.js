/**
 * End-to-end smoke test against a running server (npm start in another terminal):
 *   npm run smoke
 * Simulates a host and two players: role assignment, pack load, false start, buzz, judging, media serving.
 */
import { io } from 'socket.io-client';

const URL = process.env.URL ?? 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const c = { name, socket, state: null };
  socket.on('room:state', (s) => (c.state = s));
  c.emit = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  return c;
}

function check(cond, msg) {
  if (!cond) {
    console.error(`✘ ${msg}`);
    process.exit(1);
  }
  console.log(`✔ ${msg}`);
}

const host = client('Alice');
const p1 = client('Bob');
const p2 = client('Carol');

let r = await host.emit('session:join', { nickname: 'Alice' });
check(r.ok && r.role === 'pending', 'first joiner gets the Host/Player choice');

r = await p1.emit('session:join', { nickname: 'Bob' });
check(r.ok && r.role === 'player', 'second joiner is auto-assigned player');
const bobToken = r.token;

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
const demo = r.packs.find((p) => p.name.includes('v5')) ?? r.packs[0];

r = await host.emit('packs:load', { file: demo.file });
check(r.ok, `pack loaded: ${demo.name}`);

r = await host.emit('game:start');
await sleep(50);
check(r.ok && host.state.game.phase === 'board', 'game started, board shown');

r = await host.emit('game:select', { themeIndex: 0, questionIndex: 1 });
await sleep(50);
check(r.ok && host.state.game.phase === 'reading', 'host selected a question → reading');
check(host.state.game.current.right?.length > 0, 'host sees the answer');
check(p1.state.game.current.right === null, 'players do NOT see the answer');

const img = p1.state.game.current.content.find((i) => i.type === 'image');
if (img) {
  const res = await fetch(URL + img.url);
  check(res.ok && res.headers.get('content-type').includes('image'), `media served: ${img.url}`);
}

r = await p1.emit('game:buzz');
check(r.result === 'falseStart', `pressing during reading = false start (${JSON.stringify(r)})`);

r = await host.emit('game:openBuzzer');
await sleep(20);
r = await p1.emit('game:buzz');
check(r.result === 'ignored', 'false-started player is still blocked');
r = await p2.emit('game:buzz');
await sleep(150);
check(host.state.game.phase === 'answering' && host.state.game.buzzer.winnerId === p2.state.you.id, 'Carol won the buzzer');

r = await host.emit('game:judge', { correct: false });
await sleep(50);
const price = host.state.game.current.price;
check(host.state.participants.find((p) => p.name === 'Carol').score === -price, 'wrong answer subtracts the price');
check(host.state.game.phase === 'buzzerOpen', 'buttons reopen for remaining players');

await sleep(3100); // Bob's false-start block expires (default 3s)
r = await p1.emit('game:buzz');
await sleep(150);
r = await host.emit('game:judge', { correct: true });
await sleep(50);
check(host.state.participants.find((p) => p.name === 'Bob').score === price, 'correct answer adds the price');
check(p1.state.game.current.right?.length > 0, 'answer revealed to players');

r = await host.emit('game:next');
await sleep(50);
check(host.state.game.phase === 'board' && host.state.game.chooserId === p1.state.you.id, 'back to board, Bob chooses next');

// Reconnect with the stored token keeps role & score (phones drop sockets all the time).
const bobId = p1.state.you.id;
p1.socket.close();
await sleep(100);
check(host.state.participants.find((p) => p.id === bobId).connected === false, 'Bob shown as disconnected');
const bob2 = client('Bob (reconnected)');
r = await bob2.emit('session:resume', { token: bobToken });
await sleep(50);
check(r.resumed && bob2.state.you.id === bobId && bob2.state.you.role === 'player', 'Bob resumed his seat');
check(bob2.state.participants.find((p) => p.id === bobId).score === price, 'score preserved after reconnect');

// Test disabling falseStart (фальшстарт OFF): selecting a question opens buzzers immediately.
r = await host.emit('settings:update', { falseStart: false });
await sleep(30);
check(r.ok && host.state.settings.falseStart === false, 'host disabled falseStart (фальшстарт OFF)');
r = await bob2.emit('game:select', { themeIndex: 0, questionIndex: 0 });
await sleep(40);
check(r.ok && host.state.game.phase === 'buzzerOpen', 'with falseStart OFF, question goes directly to buzzerOpen');
r = await bob2.emit('game:buzz');
await sleep(50);
check(r.result === 'accepted' && host.state.game.phase === 'answering', 'player can buzz immediately during reading when falseStart is OFF');

// Return to board and test buzzSyncMode === 'clientTimestamp' (user request time wins over server arrival time)
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
// Carol's packet arrives at the server FIRST, with clientAt = tOpen + 60ms.
// Bob's packet arrives 30ms LATER (simulating Wi-Fi lag), but Bob actually clicked earlier at clientAt = tOpen + 15ms.
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

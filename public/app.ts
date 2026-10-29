/**
 * Frontend Client in native TypeScript (public/app.ts).
 *
 * Zero-build architecture:
 *  - Type-checked directly by `tsc --noEmit` alongside `server/` (shares `RoomSnapshot` types!)
 *  - Transpiled on-the-fly in ~2ms by the Express esbuild middleware when requested by a browser.
 */
import type { RoomSnapshot } from '../server/game/Room.ts';
import type { PackListItem } from '../server/packs/packManager.ts';
import type { ContentItem } from '../server/packs/siqParser.ts';

interface SocketAckResponse {
  ok?: boolean;
  error?: string;
  resumed?: boolean;
  token?: string;
  role?: string;
  serverTime?: number;
  packs?: PackListItem[];
  result?: string;
}

interface ClientSocket {
  connected: boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  emit(event: string, payload?: unknown, ack?: (res: SocketAckResponse) => void): void;
}

declare const io: (opts?: { transports?: string[] }) => ClientSocket;

interface GameEventPayload {
  type: string;
  playerId?: string;
  correct?: boolean;
  delta?: number;
  at?: number;
}

interface SteamProgressPayload {
  link: string;
  stage: string;
  message: string;
  percent?: number;
  file?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector) as T;

const TOKEN_KEY = 'sigame.token';
const socket: ClientSocket = io({ transports: ['websocket', 'polling'] });

let state: RoomSnapshot | null = null;
let clockOffset = 0; // calibrated serverTime - Date.now()
let bestRtt = Infinity;

/**
 * NTP-style clock calibration over WebSocket (`clock:ping`).
 */
function syncClockSample(): void {
  if (!socket.connected) return;
  const t0 = Date.now();
  socket.emit('clock:ping', {}, (res) => {
    if (!res?.ok || typeof res.serverTime !== 'number') return;
    const t1 = Date.now();
    const rtt = t1 - t0;
    const estimatedServerNow = res.serverTime + rtt / 2;
    const sampleOffset = estimatedServerNow - t1;
    if (rtt <= bestRtt) {
      bestRtt = rtt;
      clockOffset = sampleOffset;
    } else {
      clockOffset = clockOffset * 0.8 + sampleOffset * 0.2;
    }
  });
}

async function calibrateClockBurst(): Promise<void> {
  bestRtt = Infinity;
  for (let i = 0; i < 4; i++) {
    syncClockSample();
    await new Promise((r) => setTimeout(r, 120));
  }
}
setInterval(syncClockSample, 8000);

/* ---------------- Web Audio cues ---------------- */
let audioCtx: AudioContext | null = null;
function playTone(
  freq: number,
  durationMs: number,
  type: OscillatorType = 'sine',
  secondFreq: number | null = null,
): void {
  try {
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx ??= new AudioContextClass();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    if (secondFreq) {
      osc.frequency.setValueAtTime(secondFreq, audioCtx.currentTime + durationMs / 2000);
    }
    gain.gain.setValueAtTime(0.14, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  } catch {
    /* audio not unlocked yet */
  }
}

const send = (event: string, payload: unknown = {}): Promise<SocketAckResponse> =>
  new Promise((resolve) =>
    socket.emit(event, payload, (res) => {
      if (!res?.ok) alert(res?.error ?? 'Request failed');
      resolve(res);
    }),
  );

const show = (id: string): void => {
  for (const s of document.querySelectorAll<HTMLElement>('.screen')) {
    s.classList.toggle('hidden', s.id !== id);
  }
};

const nowServer = (): number => Date.now() + clockOffset;

/* ---------------- session ---------------- */

socket.on('connect', () => {
  void calibrateClockBurst();
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return show('screen-join');
  socket.emit('session:resume', { token }, (res) => {
    if (!res?.resumed) {
      localStorage.removeItem(TOKEN_KEY);
      show('screen-join');
    }
  });
});

$<HTMLFormElement>('#join-form').addEventListener('submit', (e: SubmitEvent) => {
  e.preventDefault();
  const nickname = $<HTMLInputElement>('#nickname').value;
  socket.emit('session:join', { nickname }, (res) => {
    if (!res.ok) {
      $('#join-error').textContent = res.error ?? 'Failed to join';
      return;
    }
    if (res.token) localStorage.setItem(TOKEN_KEY, res.token);
  });
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-role]')) {
  b.addEventListener('click', () => {
    void send('role:choose', { role: b.dataset.role });
  });
}

socket.on('session:kicked', () => {
  localStorage.removeItem(TOKEN_KEY);
  alert('You were removed by the host');
  show('screen-join');
});

/* ---------------- state & events ---------------- */

socket.on('room:state', (s: RoomSnapshot) => {
  state = s;
  if (!Number.isFinite(bestRtt)) clockOffset = s.serverTime - Date.now();
  render();
});

socket.on('game:event', (evt: GameEventPayload) => {
  if (evt.type === 'buzzerOpen') {
    playTone(660, 220, 'triangle', 880);
  } else if (evt.type === 'buzzAccepted') {
    playTone(520, 260, 'square', 780);
  } else if (evt.type === 'falseStart') {
    playTone(210, 320, 'sawtooth', 150);
  } else if (evt.type === 'answerJudged') {
    if (evt.correct) playTone(587, 300, 'triangle', 880);
    else playTone(240, 300, 'sawtooth', 180);
  }
});

function render(): void {
  if (!state) return;
  const { you, game } = state;
  if (!you) return show('screen-join');
  if (you.role === 'pending') return show('screen-role');
  show('screen-game');

  $('#me').textContent = `${you.name} · ${you.role}${you.isOwner ? ' · owner' : ''}`;
  $('#phase').textContent = game.round ? `${game.round.name} · ${game.phase}` : game.phase;

  renderPlayers();
  renderManage();
  renderBoard();
  renderQuestion();
  renderHostControls();
  updateOrientiers();
}

function renderHostControls(): void {
  if (!state?.you) return;
  const { you, game } = state;
  const mod = you.canModerate && game.phase !== 'lobby';
  $('#host-controls').classList.toggle('hidden', !mod);
  if (!mod) return;

  const openBtn = $<HTMLButtonElement>('#btn-open-buzzer');
  if (openBtn) {
    openBtn.disabled = game.phase !== 'reading';
    openBtn.textContent =
      game.phase === 'reading' ? '🔓 Open buttons now (Открыть кнопки)' : '🟢 Buttons already open';
  }
}

function renderPlayers(): void {
  if (!state?.you) return;
  const { participants, game, you } = state;
  const now = nowServer();
  const blockedMap = new Map<string, number>((game.buzzer?.blockedPlayers ?? []).map((b) => [b.id, b.until]));
  const attemptedSet = new Set<string>(game.buzzer?.attempted ?? []);

  const playersEl = $('#players');
  playersEl.innerHTML = '';
  for (const p of participants) {
    const el = document.createElement('div');
    el.className = 'player';
    if (!p.connected) el.classList.add('off');
    if (p.id === game.chooserId && game.phase === 'board') el.classList.add('chooser');

    const isAnswering = p.id === game.buzzer.winnerId && game.phase === 'answering';
    const blockedUntil = blockedMap.get(p.id) ?? 0;
    const isBlocked = blockedUntil > now;
    const hasTried = attemptedSet.has(p.id);

    if (isAnswering) el.classList.add('answering');
    else if (isBlocked) el.classList.add('blocked');

    el.innerHTML = `<b></b><small></small><div class="badge-slot"></div>`;
    el.querySelector('b')!.textContent = p.name;
    el.querySelector('small')!.textContent = p.role === 'player' ? `${p.score} pts` : p.role;

    const slot = el.querySelector<HTMLElement>('.badge-slot')!;
    if (isAnswering) {
      slot.innerHTML = `<span class="badge answering-badge">🎤 Answering</span>`;
    } else if (isBlocked) {
      const secs = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
      slot.innerHTML = `<span class="badge blocked-badge">🚫 False start (${secs}s)</span>`;
    } else if (hasTried) {
      slot.innerHTML = `<span class="badge tried-badge">✘ Answered</span>`;
    }

    if (you.canModerate && p.role === 'player') {
      const row = document.createElement('div');
      row.className = 'row';
      const plus = Object.assign(document.createElement('button'), { textContent: '+100' });
      const minus = Object.assign(document.createElement('button'), { textContent: '−100' });
      plus.onclick = () => void send('score:adjust', { targetId: p.id, delta: 100 });
      minus.onclick = () => void send('score:adjust', { targetId: p.id, delta: -100 });
      row.append(plus, minus);
      el.append(row);
    }
    playersEl.append(el);
  }
}

/* ---------------- lobby settings & packs ---------------- */

let packsLoaded = false;
async function refreshPacks(): Promise<void> {
  const res = await send('packs:list');
  if (!res.ok || !res.packs) return;
  const packList = $('#pack-list');
  packList.innerHTML = '';
  for (const p of res.packs) {
    const li = document.createElement('li');
    const btn = Object.assign(document.createElement('button'), { textContent: 'Load' });
    btn.onclick = () => void send('packs:load', { file: p.file });
    li.append(btn, ` ${p.name} (${p.rounds ?? '?'} rounds, ${(p.size / 1e6).toFixed(1)} MB)`);
    packList.append(li);
  }
}

function renderManage(): void {
  if (!state?.you) return;
  const showManage = state.you.canManage && state.game.phase === 'lobby';
  $('#manage').classList.toggle('hidden', !showManage);
  if (!showManage) return;

  if (!packsLoaded) {
    packsLoaded = true;
    void refreshPacks();
  }
  $('#pack-current').textContent = state.pack
    ? `✅ Loaded: ${state.pack.name} — ${state.pack.stats.questions} questions (${state.pack.rounds.length} rounds)`
    : '⚠️ No pack loaded yet — choose or download one below';

  const s = state.settings;
  const falseStartInput = $<HTMLInputElement>('#set-falseStart');
  if (document.activeElement !== falseStartInput) falseStartInput.checked = !!s.falseStart;
  $('#set-falseStart-desc').textContent = s.falseStart
    ? `ON (Вкл): Players must wait until the question is read (amber border). Pressing early = false start penalty (${s.timeForBlockingButton}s block).`
    : 'OFF (Выкл): Buzzers open immediately as soon as the question appears (green border). Players can buzz while reading.';

  const syncSelect = $<HTMLSelectElement>('#set-buzzSyncMode');
  if (document.activeElement !== syncSelect) {
    syncSelect.value = s.buzzSyncMode || 'server';
  }
  $('#set-buzzSyncMode-desc').textContent =
    s.buzzSyncMode === 'clientTimestamp'
      ? `User Request Time (По нажатию игрока): Server waits ${s.buzzSyncWindowMs}ms and picks the player whose calibrated device timestamp was earliest (compensates Wi-Fi ping).`
      : 'Server Arrival Time (По серверу): The first packet that reaches the server wins immediately.';

  const numFields = [
    'timeForBlockingButton',
    'buzzSyncWindowMs',
    'readingSpeed',
    'timeForThinkingOnQuestion',
    'timeForPrintingAnswer',
  ] as const;
  for (const key of numFields) {
    const input = $<HTMLInputElement>(`#set-${key}`);
    if (input && document.activeElement !== input) input.value = String(s[key]);
    if (input && key === 'timeForBlockingButton') input.disabled = !s.falseStart;
    if (input && key === 'buzzSyncWindowMs') input.disabled = s.buzzSyncMode !== 'clientTimestamp';
  }
  const ignoreWrongInput = $<HTMLInputElement>('#set-ignoreWrong');
  if (document.activeElement !== ignoreWrongInput) {
    ignoreWrongInput.checked = !!s.ignoreWrong;
  }
}

$<HTMLInputElement>('#set-falseStart').addEventListener('change', (e: Event) => {
  void send('settings:update', { falseStart: (e.target as HTMLInputElement).checked });
});
$<HTMLSelectElement>('#set-buzzSyncMode').addEventListener('change', (e: Event) => {
  void send('settings:update', { buzzSyncMode: (e.target as HTMLSelectElement).value });
});
$<HTMLInputElement>('#set-ignoreWrong').addEventListener('change', (e: Event) => {
  void send('settings:update', { ignoreWrong: (e.target as HTMLInputElement).checked });
});
for (const key of [
  'timeForBlockingButton',
  'buzzSyncWindowMs',
  'readingSpeed',
  'timeForThinkingOnQuestion',
  'timeForPrintingAnswer',
] as const) {
  $<HTMLInputElement>(`#set-${key}`).addEventListener('change', (e: Event) => {
    const val = Number.parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isFinite(val)) void send('settings:update', { [key]: val });
  });
}

/* ---------------- board & question ---------------- */

function renderBoard(): void {
  if (!state?.you) return;
  const { game, you } = state;
  const board = $('#board');
  board.innerHTML = '';
  if (game.phase !== 'board') return;
  const cols = Math.max(...game.board.map((t) => t.questions.length), 1);
  board.style.gridTemplateColumns = `minmax(120px, 2fr) repeat(${cols}, 1fr)`;
  const canPick = you.canModerate || you.id === game.chooserId;
  game.board.forEach((theme, t) => {
    board.append(Object.assign(document.createElement('div'), { className: 'theme', textContent: theme.name }));
    for (let q = 0; q < cols; q++) {
      const cell = theme.questions[q];
      const el = document.createElement('div');
      el.className = 'cell' + (cell?.available ? '' : ' used');
      el.textContent = cell?.price != null ? String(cell.price) : '';
      if (cell?.available && canPick) {
        el.onclick = () => void send('game:select', { themeIndex: t, questionIndex: q });
      }
      board.append(el);
    }
  });
}

function createMediaPlayer(type: 'audio' | 'video', url: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'media-wrap';

  const el = document.createElement(type);
  el.controls = true;
  el.preload = 'auto';
  el.autoplay = true;
  if (el instanceof HTMLVideoElement) {
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
  }
  el.src = url;
  wrap.append(el);

  const status = document.createElement('div');
  status.className = 'media-status hidden';
  wrap.append(status);

  const showTapToPlay = (): void => {
    status.className = 'media-status';
    status.innerHTML = '';
    const btn = Object.assign(document.createElement('button'), {
      type: 'button' as const,
      className: 'media-tap-btn',
      textContent:
        type === 'video' ? '▶️ Запустить видео (Tap to play video)' : '▶️ Запустить аудио (Tap to play audio)',
    });
    btn.onclick = () => {
      el.muted = false;
      el.play()
        .then(() => status.classList.add('hidden'))
        .catch(() => {});
    };
    status.append(btn);
  };

  const tryPlay = (): void => {
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        status.classList.add('hidden');
      }).catch(() => {
        if (type === 'video' && !el.muted) {
          el.muted = true;
          el.play()
            .then(() => {
              status.className = 'media-status';
              status.innerHTML = '';
              const btn = Object.assign(document.createElement('button'), {
                type: 'button' as const,
                className: 'media-tap-btn',
                textContent: '🔇 Включить звук (Tap to unmute)',
              });
              btn.onclick = () => {
                el.muted = false;
                el.play().catch(() => {});
                status.classList.add('hidden');
              };
              status.append(btn);
            })
            .catch(() => showTapToPlay());
        } else {
          showTapToPlay();
        }
      });
    }
  };

  el.addEventListener('loadedmetadata', tryPlay, { once: true });
  setTimeout(tryPlay, 50);

  return wrap;
}

function contentHtml(items: ContentItem[] | null | undefined): HTMLElement {
  const div = document.createElement('div');
  for (const it of items ?? []) {
    let el: HTMLElement;
    if (it.type === 'image' && it.url) el = Object.assign(document.createElement('img'), { src: it.url });
    else if ((it.type === 'audio' || it.type === 'video') && it.url) el = createMediaPlayer(it.type, it.url);
    else
      el = Object.assign(document.createElement('p'), {
        textContent: it.missing ? `[missing ${it.type}: ${it.value}]` : it.value,
      });
    div.append(el);
  }
  return div;
}

let renderedQuestionKey: string | null = null;
function renderQuestion(): void {
  if (!state) return;
  const { game } = state;
  const c = game.current;
  const box = $('#question');
  box.classList.toggle('hidden', !c);

  box.classList.remove('frame-reading', 'frame-open', 'frame-answering');
  if (game.phase === 'reading') box.classList.add('frame-reading');
  else if (game.phase === 'buzzerOpen') box.classList.add('frame-open');
  else if (game.phase === 'answering') box.classList.add('frame-answering');

  if (!c) {
    renderedQuestionKey = null;
    return;
  }
  const key = `${game.roundIndex}:${c.themeIndex}:${c.questionIndex}:${!!c.right}`;
  if (key === renderedQuestionKey) return;
  renderedQuestionKey = key;

  box.innerHTML = '';
  box.append(
    Object.assign(document.createElement('h3'), {
      textContent: `${c.themeName} · ${c.price}${c.type !== 'simple' ? ` · ${c.type}` : ''}`,
    }),
  );
  box.append(contentHtml(c.content));
  if (c.right) {
    const ans = document.createElement('div');
    ans.className = 'answer';
    ans.append(Object.assign(document.createElement('b'), { textContent: `Answer: ${c.right.join(' / ')}` }));
    if (c.answerContent?.length) ans.append(contentHtml(c.answerContent));
    if (c.comments) ans.append(Object.assign(document.createElement('p'), { textContent: c.comments }));
    box.append(ans);
  }
}

/* ---------------- stage banner & buzzer orientiers ---------------- */

function updateOrientiers(): void {
  if (!state?.game || !state.you) return;
  const { game, you, participants, settings } = state;
  const now = nowServer();
  const banner = $('#stage-banner');
  const buzzerBtn = $('#buzzer');

  const activeStages = new Set(['reading', 'buzzerOpen', 'answering', 'reveal']);
  if (!activeStages.has(game.phase)) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden', 'state-reading', 'state-open', 'state-answering', 'state-reveal');

    const t = game.timer;
    const remMs = t ? Math.max(0, t.endsAt - now) : 0;
    const remSec = t ? (remMs / 1000).toFixed(1) + 's' : '';
    const pct = t && t.durationMs > 0 ? Math.max(0, Math.min(100, (remMs / t.durationMs) * 100)) : 0;

    $('#stage-countdown').textContent = remSec;
    $('#stage-progress-fill').style.width = `${pct}%`;

    if (game.phase === 'reading') {
      banner.classList.add('state-reading');
      $('#stage-icon').textContent = '📖';
      $('#stage-title').textContent = 'READING QUESTION — WAIT FOR SIGNAL! (Чтение вопроса — ЖДИТЕ!)';
      $('#stage-subtitle').textContent = `⚠️ Фальшстарт активен: раннее нажатие заблокирует кнопку на ${settings.timeForBlockingButton} сек.`;
    } else if (game.phase === 'buzzerOpen') {
      banner.classList.add('state-open');
      $('#stage-icon').textContent = '🟢';
      $('#stage-title').textContent = 'BUZZ NOW! — МОЖНО ЖАТЬ КНОПКУ!';
      $('#stage-subtitle').textContent = !settings.falseStart
        ? 'Чтение и приём ответов идут одновременно (фальшстарт отключён)'
        : 'Кнопки открыты! Жмите кнопку или пробел для ответа.';
    } else if (game.phase === 'answering') {
      banner.classList.add('state-answering');
      const winner = participants.find((p) => p.id === game.buzzer.winnerId);
      const info = game.buzzer?.winnerInfo;
      const timingNote =
        info?.reactionMs != null
          ? ` · ⏱️ ${info.reactionMs}ms (${info.mode === 'clientTimestamp' ? 'by user press time' : 'by server time'})`
          : '';
      $('#stage-icon').textContent = '🎤';
      $('#stage-title').textContent = `ANSWERING: ${winner ? winner.name : 'Player'} (Отвечает игрок)${timingNote}`;
      $('#stage-subtitle').textContent = you.canModerate
        ? 'Оцените ответ игрока: ✔ Correct или ✘ Wrong'
        : 'Слушаем ответ игрока…';
    } else if (game.phase === 'reveal') {
      banner.classList.add('state-reveal');
      $('#stage-icon').textContent = '✅';
      $('#stage-title').textContent = `CORRECT ANSWER: ${(game.current?.right ?? []).join(' / ')}`;
      $('#stage-subtitle').textContent = 'Ожидание следующего вопроса…';
      $('#stage-countdown').textContent = '';
      $('#stage-progress-fill').style.width = '100%';
    }
  }

  const showBuzzer = you.role === 'player' && game.phase !== 'lobby';
  buzzerBtn.classList.toggle('hidden', !showBuzzer);
  if (!showBuzzer) return;

  buzzerBtn.classList.remove('buzz-reading', 'buzz-open', 'buzz-blocked', 'buzz-you-answering', 'buzz-idle');
  const blockedUntil = game.buzzer?.blockedUntil ?? 0;
  const isBlocked = blockedUntil > now;
  const alreadyTried = (game.buzzer?.attempted ?? []).includes(you.id);

  if (isBlocked) {
    const remBlock = ((blockedUntil - now) / 1000).toFixed(1);
    buzzerBtn.classList.add('buzz-blocked');
    $('#buzzer-main').textContent = `🚫 ФАЛЬШСТАРТ (${remBlock}s)`;
    $('#buzzer-sub').textContent = 'Кнопка временно заблокирована за нажатие до сигнала';
  } else if (alreadyTried && (game.phase === 'buzzerOpen' || game.phase === 'answering')) {
    buzzerBtn.classList.add('buzz-idle');
    $('#buzzer-main').textContent = '✘ ВЫ УЖЕ ОТВЕЧАЛИ';
    $('#buzzer-sub').textContent = 'Ждём остальных игроков на этом вопросе';
  } else if (game.phase === 'reading') {
    buzzerBtn.classList.add('buzz-reading');
    $('#buzzer-main').textContent = '✋ ЖДИТЕ СИГНАЛА…';
    $('#buzzer-sub').textContent = `Идёт чтение вопроса! Нажатие сейчас = фальшстарт (−${settings.timeForBlockingButton}с)`;
  } else if (game.phase === 'buzzerOpen') {
    buzzerBtn.classList.add('buzz-open');
    $('#buzzer-main').textContent = '🟢 ЖМИ! / BUZZ!';
    $('#buzzer-sub').textContent = 'Кликните сюда или нажмите ПРОБЕЛ (Space)';
  } else if (game.phase === 'answering') {
    if (game.buzzer.winnerId === you.id) {
      buzzerBtn.classList.add('buzz-you-answering');
      $('#buzzer-main').textContent = '🎤 ВАШ ОТВЕТ!';
      $('#buzzer-sub').textContent = 'Назовите ответ ведущему!';
    } else {
      const winner = participants.find((p) => p.id === game.buzzer.winnerId);
      buzzerBtn.classList.add('buzz-idle');
      $('#buzzer-main').textContent = `⏳ Отвечает ${winner ? winner.name : 'другой игрок'}…`;
      $('#buzzer-sub').textContent = 'Приготовьтесь: если ошибётся, кнопка снова станет зелёной';
    }
  } else {
    buzzerBtn.classList.add('buzz-idle');
    $('#buzzer-main').textContent = '⏸ ОЖИДАНИЕ ВОПРОСА';
    $('#buzzer-sub').textContent = 'Кнопка активируется после выбора вопроса';
  }
}

/* ---------------- fast tick for smooth countdown bars ---------------- */

setInterval(() => {
  if (!state?.game) return;
  const t = state.game.timer;
  $('#timer').textContent = t ? `${t.name} ${Math.max(0, Math.ceil((t.endsAt - nowServer()) / 1000))}s` : '';
  updateOrientiers();
}, 100);

/* ---------------- controls ---------------- */

function triggerBuzz(): void {
  socket.emit('game:buzz', { clientAt: Math.round(nowServer()) }, () => {});
}

$('#buzzer').addEventListener('pointerdown', triggerBuzz);
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (
    e.code === 'Space' &&
    state?.you?.role === 'player' &&
    (document.activeElement as HTMLElement | null)?.tagName !== 'INPUT'
  ) {
    e.preventDefault();
    triggerBuzz();
  }
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-act]')) {
  b.addEventListener('click', () => {
    const act = b.dataset.act ?? '';
    if (act === 'judge-ok') void send('game:judge', { correct: true });
    else if (act === 'judge-bad') void send('game:judge', { correct: false });
    else void send(act);
  });
}

$('#btn-start').addEventListener('click', () => void send('game:start'));

$<HTMLFormElement>('#steam-form').addEventListener('submit', (e: SubmitEvent) => {
  e.preventDefault();
  $('#steam-log').textContent = '';
  void send('steam:download', { link: $<HTMLInputElement>('#steam-link').value });
});
socket.on('steam:progress', (p: SteamProgressPayload) => {
  const log = $('#steam-log');
  log.textContent += `[${p.stage}] ${p.message}${p.percent != null ? ` (${p.percent}%)` : ''}\n`;
  log.scrollTop = log.scrollHeight;
});
socket.on('packs:changed', () => void refreshPacks());

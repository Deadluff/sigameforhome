import { io, type Socket } from 'socket.io-client';
import { ContentPresenter } from './contentPresenter';
import { avatar, formatScore, questionTypeLabel, replicFor, roleLabels, sayReplic, toast, type ReplicTone } from './ui';
import { audioCue, drawPins, drawRing, fitText, imageFrame, makePickable, optionText, optionTiles, parsePoint,
  setBackdrop, type Pin } from './stageParts';
import type { Ack, ClientToServerEvents, CommandEvent, CommandPayloads, ContentItem,
  GameEvent, JoinAck, NoPayloadCommand, PackListItem, RoomState, ServerToClientEvents } from './types';

/* Client UI with clear reading/buzzer orientiers & pre-game falseStart setting. */
(() => {
  function $(selector: string): HTMLElement {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`Missing UI element: ${selector}`);
    return element;
  }

  function input(selector: string): HTMLInputElement {
    const element = $(selector);
    if (!(element instanceof HTMLInputElement)) throw new Error(`Expected input: ${selector}`);
    return element;
  }

  function textarea(selector: string): HTMLTextAreaElement {
    const element = $(selector);
    if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Expected textarea: ${selector}`);
    return element;
  }

  function select(selector: string): HTMLSelectElement {
    const element = $(selector);
    if (!(element instanceof HTMLSelectElement)) throw new Error(`Expected select: ${selector}`);
    return element;
  }

  function button(selector: string): HTMLButtonElement {
    const element = $(selector);
    if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button: ${selector}`);
    return element;
  }

  type ActiveRoomState = RoomState & { you: NonNullable<RoomState['you']> };
  const hasActivePlayer = (value: RoomState | null): value is ActiveRoomState => value?.you != null;
  function activeState(): ActiveRoomState {
    if (!hasActivePlayer(state)) throw new Error('Game state is not ready');
    return state;
  }

  const controlCommands = new Set<string>([
    'game:pause', 'game:resume', 'game:openBuzzer', 'game:reveal',
    'game:next', 'game:prevRound', 'game:nextRound', 'game:stop', 'game:closeForAll', 'game:appealClose',
  ] satisfies NoPayloadCommand[]);
  const isNoPayloadCommand = (value: string): value is NoPayloadCommand => controlCommands.has(value);
  const tvMode = new URLSearchParams(location.search).has('tv');
  const TOKEN_KEY = tvMode ? 'sigame.tv.token' : 'sigame.token';
  if (tvMode) document.body.classList.add('tv-mode');
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ transports: ['websocket', 'polling'] });

  let state: RoomState | null = null;
  let clockOffset = 0; // serverTime - Date.now()
  let bestRtt = Infinity;
  let actionUncertain = false;
  const uncertainActionMessage = 'Action outcome unknown. It may still have applied; check the game state before retrying.';
  const unsentActionMessage = 'Action was not sent. Reconnect before trying again.';

  // Lowest-latency samples give client timestamps a stable server clock estimate.
  function syncClockSample() {
    if (!socket.connected) return;
    const sentAt = Date.now();
    socket.emit('clock:ping', {}, (res) => {
      if (!res?.ok || !Number.isFinite(res.serverTime)) return;
      const receivedAt = Date.now();
      const rtt = receivedAt - sentAt;
      const sampleOffset = res.serverTime + rtt / 2 - receivedAt;
      if (rtt <= bestRtt) {
        bestRtt = rtt;
        clockOffset = sampleOffset;
      } else {
        clockOffset = clockOffset * 0.8 + sampleOffset * 0.2;
      }
    });
  }

  async function calibrateClockBurst() {
    bestRtt = Infinity;
    for (let i = 0; i < 4; i++) {
      syncClockSample();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  setInterval(syncClockSample, 8000);

  /* ---------------- Volume ---------------- */
  // Each device keeps its own level, so a loud TV and a quiet phone can share one room.
  const VOLUME_KEY = 'sigame.volume';
  let volume = 1;
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    if (saved !== null && Number.isFinite(Number(saved))) volume = Math.min(1, Math.max(0, Number(saved)));
  } catch { /* Private mode: keep full volume. */ }
  // iPhone and iPad ignore media.volume, so same-origin clips play through a Web Audio gain instead.
  let masterGain: GainNode | null = null;
  const routedMedia = new WeakSet<HTMLMediaElement>();
  function routeThroughVolume(el: HTMLMediaElement, url: string) {
    el.volume = volume;
    // A suspended context would silence the clip, and cross-origin clips play silent through Web Audio.
    if (!audioCtx || audioCtx.state !== 'running' || new URL(url, location.href).origin !== location.origin) return;
    try {
      if (!masterGain) {
        masterGain = audioCtx.createGain();
        masterGain.connect(audioCtx.destination);
      }
      audioCtx.createMediaElementSource(el).connect(masterGain);
      masterGain.gain.value = volume;
      el.volume = 1; // The gain does the work; also lowering the element would square the level.
      routedMedia.add(el);
    } catch { /* Keep the plain element volume. */ }
  }
  function applyVolume() {
    if (masterGain) masterGain.gain.value = volume;
    for (const media of questionMedia()) media.volume = routedMedia.has(media) ? 1 : volume;
    input('#volume-range').value = String(Math.round(volume * 100));
    $('#volume-value').textContent = `${Math.round(volume * 100)}%`;
    button('#btn-volume').dataset.icon = volume === 0 ? 'mute' : 'volume';
  }
  input('#volume-range').addEventListener('input', () => {
    volume = Number(input('#volume-range').value) / 100;
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* Not saved; still applies now. */ }
    applyVolume();
  });
  button('#btn-volume').onclick = (event) => {
    event.stopPropagation();
    const open = $('#volume-pop').classList.toggle('hidden') === false;
    button('#btn-volume').setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('click', (event) => {
    if (!(event.target as Element).closest?.('.volume')) {
      $('#volume-pop').classList.add('hidden');
      button('#btn-volume').setAttribute('aria-expanded', 'false');
    }
  });

  /* ---------------- Web Audio cues ---------------- */
  let audioCtx: AudioContext | null = null;
  // Mobile browsers require audio to be unlocked during a user gesture.
  const unlockAudio = () => {
    try {
      audioCtx ??= new AudioContext();
      void audioCtx.resume().catch(() => {});
    } catch { /* audio is optional */ }
  };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  function playTone(freq: number, durationMs: number, type: OscillatorType = 'sine', secondFreq: number | null = null) {
    try {
      audioCtx ??= new AudioContext();
      if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      if (secondFreq) {
        osc.frequency.setValueAtTime(secondFreq, audioCtx.currentTime + durationMs / 2000);
      }
      if (volume === 0) return;
      gain.gain.setValueAtTime(0.14 * volume, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch {
      /* audio not unlocked yet */
    }
  }

  function send<Event extends keyof CommandPayloads>(event: Event, payload: CommandPayloads[Event]): Promise<Ack>;
  function send(event: NoPayloadCommand): Promise<Ack>;
  function send(event: CommandEvent, payload: Record<string, unknown> = {}): Promise<Ack> {
    if (!socket.connected) {
      if (!actionUncertain) $('#connection-status').textContent = unsentActionMessage;
      return Promise.resolve({ ok: false, error: unsentActionMessage });
    }
    // Overloads check each command at call sites; this cast only joins their union for Socket.IO.
    const emit = socket.emit.bind(socket) as
      (name: CommandEvent, data: Record<string, unknown>, ack: (result: Ack) => void) => void;
    return new Promise((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Ack, uncertain = false) => {
        if (settled) return; // A late acknowledgement must not show a second result.
        settled = true;
        if (timeout) clearTimeout(timeout);
        socket.off('disconnect', onDisconnect);
        if (uncertain) {
          actionUncertain = true;
          $('#connection-status').textContent = uncertainActionMessage;
        } else if (!result.ok) {
          toast(result.error ?? 'Request failed');
        } else if (actionUncertain) {
          actionUncertain = false;
          $('#connection-status').textContent = '';
        }
        resolve(result);
      };
      const onDisconnect = () => finish({ ok: false, error: uncertainActionMessage }, true);
      socket.once('disconnect', onDisconnect);
      timeout = setTimeout(() => finish({ ok: false, error: uncertainActionMessage }, true), 8000);
      emit(event, payload, (result) => finish(result ?? { ok: false, error: 'Request failed' }));
    });
  }

  const show = (id: string) => {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  };

  const nowServer = () => Date.now() + clockOffset;

  /* ---------------- session ---------------- */

  socket.on('connect', () => {
    void calibrateClockBurst();
    $('#connection-status').textContent = actionUncertain ? uncertainActionMessage : '';
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      if (tvMode) {
        socket.emit('session:join', { nickname: `TV ${Math.floor(Math.random() * 10000)}`, asSpectator: true }, (res: JoinAck) => {
          if (res.ok) localStorage.setItem(TOKEN_KEY, res.token);
          else { show('screen-join'); $('#join-error').textContent = res.error; }
        });
        return;
      }
      return show('screen-join');
    }
    socket.emit('session:resume', { token }, (res: { resumed?: boolean }) => {
      if (!res?.resumed) {
        localStorage.removeItem(TOKEN_KEY);
        actionUncertain = false;
        $('#connection-status').textContent = '';
        if (tvMode) location.reload();
        else {
          $('#join-error').textContent = 'Previous session expired. Join again.';
          show('screen-join');
        }
      }
    });
  });
  socket.on('disconnect', () => {
    // Reconnection rotates media tickets, so rebuild the question with fresh URLs.
    renderedQuestionKey = null;
    presenterAckingId = null;
    $('#connection-status').textContent = actionUncertain
      ? uncertainActionMessage : 'Disconnected — reconnecting…';
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#join-error').textContent = '';
    socket.emit('session:join', { nickname: input('#nickname').value }, (res: JoinAck) => {
      if (!res.ok) return ($('#join-error').textContent = res.error);
      localStorage.setItem(TOKEN_KEY, res.token);
    });
  });

  for (const b of document.querySelectorAll<HTMLElement>('[data-role]')) {
    b.addEventListener('click', () => {
      const role = b.dataset.role;
      if (role === 'host' || role === 'player') send('role:choose', { role });
    });
  }

  socket.on('session:kicked', () => {
    localStorage.removeItem(TOKEN_KEY);
    actionUncertain = false;
    $('#connection-status').textContent = '';
    toast('The host removed you from the room.');
    show('screen-join');
  });

  async function leaveRoom() {
    if (!confirm('Leave this room?')) return;
    const result = await send('session:leave');
    if (!result.ok) return;
    // The server has removed this socket, so a later reconnect must not resume the old seat.
    localStorage.removeItem(TOKEN_KEY);
    state = null;
    actionUncertain = false;
    $('#connection-status').textContent = '';
    show('screen-join');
  }
  button('#btn-leave').onclick = leaveRoom;
  button('#btn-leave-role').onclick = leaveRoom;

  /* ---------------- state & events ---------------- */

  /*
   * The pick's signature move: the lit cell grows into the question card, and after the reveal the card
   * shrinks back into the played cell. Only these two changes animate. It is skipped when buttons open
   * at once (the transition overlay would eat early taps), with reduced motion, or without the API.
   */
  let lastPick: { round: number; theme: number; question: number } | null = null;
  let pickTransitionRunning = false;
  function pickTransition(prev: RoomState | null, next: RoomState): boolean {
    if (!prev?.game || !('startViewTransition' in document) || pickTransitionRunning) return false;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    const from = prev.game.phase, to = next.game.phase;
    if (from === 'intro' && to === 'reading') return true;
    return from === 'reveal' && to === 'board' && lastPick?.round === next.game.roundIndex;
  }

  // Host shortcuts pause briefly whenever the step changes (see the keydown handler below).
  let stepKey = '';
  let stepChangedAt = 0;
  socket.on('room:state', (s: RoomState) => {
    const prev = state;
    state = s;
    const key = `${s.game?.phase}:${s.game?.timer?.name ?? ''}:${s.game?.current?.presentationId ?? ''}`;
    if (key !== stepKey) { stepKey = key; stepChangedAt = Date.now(); }
    if (!Number.isFinite(bestRtt)) clockOffset = s.serverTime - Date.now();
    const c = s.game?.current;
    if (c && ['intro', 'reading'].includes(s.game.phase)) {
      lastPick = { round: s.game.roundIndex, theme: c.themeIndex, question: c.questionIndex };
    }
    if (!pickTransition(prev, s)) return render();
    pickTransitionRunning = true;
    const transition = document.startViewTransition(() => render());
    void transition.finished.finally(() => { pickTransitionRunning = false; });
  });

  // A short line over the podium shows what just happened to whom, like the show's speech bubbles.
  function replicOf(evt: GameEvent): [string, string, ReplicTone] | null {
    if (!('playerId' in evt) || !evt.playerId) return null;
    switch (evt.type) {
      // An assigned player never pressed a button, so "Buzzed!" would be wrong.
      case 'buzzAccepted': return [evt.playerId, evt.assigned ? 'Answering' : 'Buzzed!', 'plain'];
      case 'falseStart': return [evt.playerId, 'Too early', 'stop'];
      case 'answerJudged': {
        const delta = evt.delta ?? 0;
        if (evt.correct) return [evt.playerId, delta ? `+${formatScore(delta)}` : 'Correct', 'go'];
        return [evt.playerId, delta ? formatScore(delta) : 'Wrong', 'stop'];
      }
      case 'stakeBid': return [evt.playerId, evt.allIn ? `All in: ${formatScore(evt.amount)}` : `Bid ${formatScore(evt.amount)}`, 'lamp'];
      case 'stakePass': return [evt.playerId, 'Pass', 'plain'];
      case 'stakeWon': return [evt.playerId, `Takes it for ${formatScore(evt.amount)}`, 'lamp'];
      case 'giftAwarded': return [evt.playerId, `Gift +${formatScore(evt.price)}`, 'go'];
      default: return null;
    }
  }

  socket.on('game:event', (evt) => {
    const replic = replicOf(evt);
    if (replic) {
      sayReplic(replic[0], replic[1], replic[2], () => { if (hasActivePlayer(state)) renderPlayers(); });
      if (hasActivePlayer(state)) renderPlayers();
    }
    if (evt.type === 'questionSelected') {
      playTone(440, 160, 'triangle', 660);
    } else if (evt.type === 'buzzerOpen') {
      playTone(660, 220, 'triangle', 880);
      // A short buzz in the hand on Android; iPhones ignore it.
      if (state?.you?.role === 'player') navigator.vibrate?.(30);
    } else if (evt.type === 'buzzAccepted') {
      playTone(520, 260, 'square', 780);
    } else if (evt.type === 'falseStart') {
      playTone(210, 320, 'sawtooth', 150);
    } else if (evt.type === 'answerJudged') {
      if (evt.correct) playTone(587, 300, 'triangle', 880);
      else playTone(240, 300, 'sawtooth', 180);
    }
  });

  function render() {
    if (!state) return;
    const { you, game } = state;
    if (!you) return show('screen-join');
    if (you.role === 'pending') return show('screen-role');
    show('screen-game');
    $('#screen-game').dataset.phase = game.phase;
    renderTopbar();
    if (tvMode) {
      renderPlayers();
      renderResults();
      renderBoard();
      renderQuestion();
      renderTypedAnswer();
      renderStakeAuction();
      renderForAll();
      renderAppeals();
      syncQuestionMedia();
      updateOrientiers();
      return;
    }

    renderPlayers();
    renderResults();
    renderManage();
    renderBoard();
    renderQuestion();
    renderTypedAnswer();
    renderStakeAuction();
    renderForAll();
    renderAppeals();
    syncQuestionMedia();
    renderSpecialSetup();
    renderFinal();
    renderHostControls();
    updateOrientiers();
  }

  // Top bar answers "where are we" (round, step) and "who am I"; live timing lives in the status panel.
  function renderTopbar() {
    const { you, game, pack, participants } = activeState();
    const phase = $('#phase');
    phase.replaceChildren();
    if (game.phase === 'lobby') phase.textContent = pack ? pack.name : 'Lobby';
    else if (game.phase === 'gameOver') phase.textContent = 'Game over';
    else if (game.round) {
      // Packs often name rounds "1", "2"…; "2 2/3" would repeat the number, so those read "Round 2 of 3".
      const numbered = /^\d+$/.test(game.round.name.trim());
      phase.append(Object.assign(document.createElement('b'), { textContent: roundTitle(game.round.name) }));
      if (pack?.rounds.length) {
        phase.append(Object.assign(document.createElement('span'), {
          className: 'round-count',
          textContent: numbered ? `of ${pack.rounds.length}` : `${game.roundIndex + 1}/${pack.rounds.length}`,
        }));
      }
    }
    // Round arrows replace the old menu items: one tap, right next to the round name.
    const roundNav = you.canModerate && !tvMode && game.phase !== 'lobby' && !!pack;
    const prev = button('#btn-prev-round');
    const next = button('#btn-next-round');
    prev.classList.toggle('hidden', !roundNav);
    next.classList.toggle('hidden', !roundNav);
    prev.disabled = game.roundIndex <= 0 && game.phase !== 'gameOver';
    next.disabled = game.phase === 'gameOver';
    const nextLabel = pack && game.roundIndex >= pack.rounds.length - 1 ? 'Finish the game' : 'Next round';
    next.setAttribute('aria-label', nextLabel);
    next.title = nextLabel;
    const host = participants.find((p) => p.role === 'host');
    const hostChip = $('#host-chip');
    // Your own chip already says "Host", so the label names someone else or the empty seat.
    hostChip.classList.toggle('hidden', host?.id === you.id);
    hostChip.classList.toggle('vacant', !host);
    hostChip.replaceChildren();
    // Phones drop the "Hosted by" words but keep the avatar and name.
    if (host) hostChip.append(avatar(host.id, host.name),
      Object.assign(document.createElement('span'), { className: 'host-prefix', textContent: 'Hosted by ' }), host.name);
    else hostChip.textContent = 'No host yet';
    hostChip.title = host ? `Hosted by ${host.name}` : 'No host yet';
    // The owner may take the empty seat themselves; the server already allows it in the lobby.
    if (!host && you.isOwner && game.phase === 'lobby' && !tvMode) {
      const take = Object.assign(document.createElement('button'), { type: 'button', className: 'small primary', textContent: 'Become host' });
      take.onclick = () => send('role:set', { targetId: you.id, role: 'host' });
      hostChip.append(take);
    }
    const me = $('#me');
    me.replaceChildren();
    if (tvMode) me.textContent = 'TV view';
    else {
      // Phones show your own score here, so it is visible without scrolling to the podium row.
      const score = you.role === 'player' && game.phase !== 'lobby' ? participants.find((p) => p.id === you.id)?.score : undefined;
      me.append(avatar(you.id, you.name), Object.assign(document.createElement('span'), { className: 'me-name', textContent: you.name }),
        Object.assign(document.createElement('span'), { className: 'role', textContent: roleLabels[you.role] ?? you.role }));
      if (score != null) me.append(Object.assign(document.createElement('span'), {
        className: 'me-score' + (score < 0 ? ' negative' : ''), textContent: formatScore(score),
      }));
    }
    renderHostMenu();
  }

  /*
   * Phone host menu: the round arrows and the host pill do not fit a 375 px bar next to the round name,
   * so below 600 px they hide and this menu offers the same actions. Each item presses the real button,
   * so labels, confirmations and disabled states stay in one place.
   */
  function renderHostMenu() {
    const menu = $('#host-menu') as HTMLDetailsElement;
    const tools = $('#host-tools');
    const roundNav = !button('#btn-prev-round').classList.contains('hidden');
    menu.classList.toggle('hidden', !roundNav && tools.classList.contains('hidden'));
    const panel = $('#host-menu-panel');
    panel.replaceChildren();
    for (const id of ['btn-prev-round', 'btn-next-round', 'btn-pause', 'btn-resume', 'btn-settings', 'btn-stop']) {
      const real = button(`#${id}`);
      if (real.classList.contains('hidden') || (id !== 'btn-prev-round' && id !== 'btn-next-round' && tools.classList.contains('hidden'))) continue;
      const item = Object.assign(document.createElement('button'), {
        type: 'button', className: 'quiet', disabled: real.disabled,
        textContent: real.getAttribute('aria-label') ?? real.title ?? real.textContent ?? '',
      });
      if (real.dataset.icon) item.dataset.icon = real.dataset.icon;
      item.onclick = () => { menu.open = false; real.click(); };
      panel.append(item);
    }
  }

  /** The host action that is the obvious next step in this phase, or null when there is none. */
  function hostPrimaryAct(game: RoomState['game']): string | null {
    if (game.phase === 'reading' && game.current?.type !== 'forAll') return 'game:openBuzzer';
    if (game.phase === 'reveal' || game.phase === 'roundEnd') return 'game:next';
    return null;
  }

  function renderHostControls() {
    const state = activeState();
    const { you, game } = state;
    const mod = you.canModerate && game.phase !== 'lobby';
    $('#host-controls').classList.toggle('hidden', !mod);
    $('#host-tools').classList.toggle('hidden', !mod || tvMode);
    if (!mod) return renderHostMenu();
    button('#btn-pause').classList.toggle('hidden', game.phase === 'paused');
    button('#btn-pause').disabled = game.phase === 'gameOver';
    button('#btn-resume').classList.toggle('hidden', game.phase !== 'paused');
    button('#btn-undo-judgment').classList.toggle('hidden', !game.undoJudgment);
    for (const button of $('#host-controls').querySelectorAll('button')) {
      const action = button.dataset.act;
      // Tapped answers judge themselves; written ones wait for the text or its deadline.
      const tapAnswer = (game.current?.answerType ?? 'text') !== 'text';
      if (action?.startsWith('judge-')) button.disabled = game.phase !== 'answering' ||
        ((!state.settings.oral || tapAnswer) && !game.buzzer.typedAnswer?.submitted && !game.buzzer.typedAnswer?.closed);
      if (action === 'game:reveal') button.disabled = game.current?.type === 'forAll' ||
        !(['reading', 'buzzerOpen', 'answering'].includes(game.phase) ||
          (game.phase === 'reveal' && !game.current?.answerShown));
      if (action === 'game:next') button.disabled = !['intro', 'reveal', 'roundEnd', 'specialSetup', 'stakeAuction'].includes(game.phase);
      if (action === 'game:next') {
        const finalReveal = game.phase === 'reveal' && game.round?.type === 'final';
        const moreFinalThemes = game.board.some((theme) => theme.questions[0]?.available);
        button.textContent = finalReveal && state.settings.playAllQuestionsInFinalRound
          ? moreFinalThemes ? 'Next final theme' : 'Finish game'
          : game.phase === 'specialSetup' ? 'Skip question'
            // During the pick intro Next only shortens the pause; the question still plays.
            : game.phase === 'intro' ? 'Skip' : 'Next';
      }
    }

    const openBtn = button('#btn-open-buzzer');
    openBtn.classList.toggle('hidden', game.phase !== 'reading' || game.current?.type === 'forAll');
    openBtn.disabled = game.phase !== 'reading' || game.current?.type === 'forAll';
    openBtn.textContent = 'Open buzzer now';
    // One filled button per moment: the step the host is expected to take next. Verdicts are a pair, so
    // answering has none; the special-setup form and final controls bring their own primary button.
    const primaryAct = hostPrimaryAct(game);
    for (const control of $('#host-controls').querySelectorAll<HTMLButtonElement>(':scope > button[data-act]')) {
      control.classList.toggle('primary', control.dataset.act === primaryAct);
    }
    // During the intro "Skip" only shortens the pause, so it stays quiet.
    button('#host-controls [data-act="game:next"]').classList.toggle('quiet', game.phase === 'intro');
    // Keep unavailable phase actions out of the primary control strip.
    for (const control of $('#host-controls').querySelectorAll<HTMLButtonElement>(':scope > button[data-act]')) {
      control.classList.toggle('hidden', control.disabled);
    }
    // An empty bar is just a blue strip; hide it until this step has something to press.
    const busy = [...$('#host-controls').children].some((el) => !el.classList.contains('hidden'));
    $('#host-controls').classList.toggle('hidden', !busy);
    renderHostMenu();
  }

  button('#btn-undo-judgment').onclick = () => {
    const undo = state?.game.undoJudgment;
    if (!undo) return;
    const name = state?.participants.find((player) => player.id === undo.playerId)?.name ?? 'this player';
    if (confirm(`Undo the last verdict for ${name}? A revealed answer may already be known to viewers.`)) {
      send('game:undoJudgment', { presentationId: undo.presentationId, judgmentId: undo.judgmentId });
    }
  };

  let gameMediaPaused = false;
  let pausedForAnswer = false;
  let playingMediaIndices = new Set<number>();
  const manuallyPausedMedia = new WeakSet<HTMLMediaElement>();
  const gamePausedMedia = new WeakSet<HTMLMediaElement>();
  function questionMedia(): HTMLMediaElement[] {
    const media = [...document.querySelectorAll<HTMLMediaElement>('#question audio, #question video')];
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('#question iframe.question-html')) {
      // Sandboxed pack HTML shares our origin but may navigate away inside its frame.
      try { media.push(...frame.contentDocument?.querySelectorAll<HTMLMediaElement>('audio, video') ?? []); }
      catch { /* An external frame cannot expose its media controls. */ }
    }
    return media;
  }
  function syncQuestionMedia() {
    const state = activeState();
    const playbackPaused = state.game.phase === 'paused' || state.game.phase === 'answering';
    questionPresenter?.setPaused(playbackPaused);
    const media = questionMedia();
    if (playbackPaused) {
      if (state.game.phase === 'answering') pausedForAnswer = true;
      // Capture once so repeated renders do not resume clips the user had paused.
      if (!gameMediaPaused) {
        playingMediaIndices = new Set(media.flatMap((item, index) => item.paused ? [] : [index]));
        gameMediaPaused = true;
      }
      media.forEach((item) => {
        item.autoplay = false;
        if (!item.paused) gamePausedMedia.add(item);
        item.pause();
      });
    } else if (gameMediaPaused) {
      // Revealing the key ends question playback; only a wrong answer resumes it.
      if (pausedForAnswer && state.game.phase !== 'buzzerOpen' && state.game.phase !== 'reading') {
        playingMediaIndices.clear();
        gameMediaPaused = false;
        pausedForAnswer = false;
        return;
      }
      // Indices survive a media URL rebuild when a paused client reconnects.
      media.forEach((item, index) => {
        if (playingMediaIndices.has(index)) item.play().catch(() => {});
      });
      playingMediaIndices.clear();
      gameMediaPaused = false;
      pausedForAnswer = false;
    }
  }

  function renderFinal() {
    const state = activeState();
    const { game, you, participants } = state;
    const final = game.final;
    const finalist = !!final && final.eligibleIds.includes(you.id);
    const wagering = game.phase === 'finalWager';
    $('#final-wager').classList.toggle('hidden', !wagering || !finalist);
    $('#final-host').classList.toggle('hidden', !final);
    if (!final) {
      $('#final-answer').classList.add('hidden');
      return;
    }
    if (wagering && finalist) {
      const score = Math.max(0, participants.find((p) => p.id === you.id)?.score ?? 0);
      input('#final-amount').max = String(score);
      $('#final-amount-label').textContent = `Your final wager, 0 to ${formatScore(score)}`;
      $('#final-wager-status').textContent = final.wagered.includes(you.id)
        ? `Saved: ${formatScore(final.yourWager ?? 0)}` : '';
    }
    // Finalists write their answer so the host judges what was actually said.
    const answering = game.phase === 'finalQuestion' && finalist && !final.judged.includes(you.id);
    $('#final-answer').classList.toggle('hidden', !answering);
    if (answering) {
      const field = textarea('#final-answer-input');
      if (final.yourAnswer && document.activeElement !== field && !field.value) field.value = final.yourAnswer;
      $('#final-answer-status').textContent = final.yourAnswer ? 'Saved. You can change it until time is up.' : '';
    }
    const host = you.canModerate && ['finalWager', 'finalQuestion', 'finalJudge'].includes(game.phase);
    $('#final-host').classList.toggle('hidden', !host);
    if (!host) return;
    const finalists = participants.filter((p) => final.eligibleIds.includes(p.id));
    const waiting = finalists.filter((p) => p.connected && !final.wagered.includes(p.id));
    button('#btn-open-final').classList.toggle('hidden', !wagering);
    button('#btn-open-final').disabled = waiting.length > 0;
    button('#btn-close-final').classList.toggle('hidden', game.phase !== 'finalQuestion');
    const answered = finalists.filter((p) => final.answeredIds.includes(p.id)).length;
    $('#final-host-status').textContent = !finalists.length ? 'Nobody has a positive score, so nobody plays the final.'
      : wagering ? `${finalists.length - waiting.length} of ${finalists.length} wagers saved`
        : game.phase === 'finalQuestion' ? `${answered} of ${finalists.length} answers in`
          : 'Judge each answer on the podiums';
  }

  $('#final-wager').addEventListener('submit', (event) => {
    event.preventDefault();
    send('game:finalWager', { amount: Number(input('#final-amount').value) });
  });
  button('#final-all-in').onclick = () => {
    const field = input('#final-amount');
    field.value = field.max;
    send('game:finalWager', { amount: Number(field.max) });
  };
  $('#final-answer').addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = textarea('#final-answer-input').value.trim();
    if (answer) send('game:finalAnswer', { answer });
  });
  $('#btn-open-final').onclick = () => send('game:openFinal');
  $('#btn-close-final').onclick = () => send('game:closeFinal');

  function renderSpecialSetup() {
    const state = activeState();
    const visible = state.you.canModerate && state.game.phase === 'specialSetup';
    $('#special-setup').classList.toggle('hidden', !visible);
    const current = state.game.current;
    if (!visible || !current) return;
    const gift = current.type === 'secretNoQuestion';
    $('#special-setup-title').textContent = gift ? 'Gift' : 'Special question';
    $('#special-setup button[type="submit"]').textContent = gift ? 'Award points' : 'Show question';
    const playerSelect = select('#special-player');
    const previous = playerSelect.value;
    playerSelect.replaceChildren();
    // A secret marked "except current" may not go back to the player who opened it.
    const excluded = current.type.startsWith('secret') && current.selectionMode === 'exceptCurrent' ? state.game.chooserId : null;
    const eligible = state.participants.filter((p) => p.role === 'player' && p.connected && p.id !== excluded);
    for (const player of eligible) playerSelect.add(new Option(player.name, player.id));
    if (eligible.some((p) => p.id === previous)) playerSelect.value = previous;
    const range = current.priceRange;
    const priceInput = input('#special-price');
    priceInput.min = String(gift ? current.price : range?.minimum ?? current.price);
    priceInput.max = String(gift ? current.price : range?.maximum ?? Math.max(current.price,
      state.participants.find((p) => p.id === playerSelect.value)?.score ?? 0));
    priceInput.step = String(range?.step || 1);
    priceInput.readOnly = gift;
    if (document.activeElement !== priceInput) priceInput.value = priceInput.min;
  }

  $('#special-setup').addEventListener('submit', (event) => {
    event.preventDefault();
    send('game:configureSpecial', { playerId: select('#special-player').value, price: Number(input('#special-price').value) });
  });

  function renderStakeAuction() {
    const { game, you, participants } = activeState();
    const auction = game.auction;
    const pausedAuction = game.phase === 'paused' && game.pausedPhase === 'stakeAuction';
    const visible = (game.phase === 'stakeAuction' || pausedAuction) && auction !== null;
    $('#stake-auction').classList.toggle('hidden', !visible);
    if (!visible || !auction) return;

    const playerName = (id: string | null) => participants.find((p) => p.id === id)?.name ?? 'Player';
    $('#stake-auction-status').textContent = auction.leaderId
      ? `${playerName(auction.leaderId)} leads with ${auction.amount} points${auction.allIn ? ' (all in)' : ''}.`
      : `Opening bid: ${auction.minimum} points.`;

    const myTurn = game.phase === 'stakeAuction' && you.role === 'player' && auction.turnId === you.id;
    $('#stake-bid-form').classList.toggle('hidden', !myTurn);
    $('#stake-auction-hint').textContent = pausedAuction ? 'The auction is paused.' : myTurn
      ? `Your turn. Bid at least ${auction.minimumNextBid}, go all in, or pass.`
      : auction.turnId ? `${playerName(auction.turnId)} is choosing a bid.` : 'Auction is ending…';
    if (!myTurn) return;

    const score = participants.find((p) => p.id === you.id)?.score ?? 0;
    const maxRegular = Math.max(game.current?.price ?? auction.minimum, score);
    const canBid = !auction.allIn && maxRegular >= auction.minimumNextBid;
    const bidInput = input('#stake-bid-amount');
    bidInput.min = String(auction.minimumNextBid);
    bidInput.max = String(maxRegular);
    bidInput.step = '1';
    bidInput.disabled = !canBid;
    button('#stake-bid-form button[type="submit"]').disabled = !canBid;
    button('#stake-all-in').disabled = score < auction.minimum || score <= auction.amount;
    if (document.activeElement !== bidInput &&
        (!bidInput.value || Number(bidInput.value) < auction.minimumNextBid || Number(bidInput.value) > maxRegular)) {
      bidInput.value = String(auction.minimumNextBid);
    }
  }

  $('#stake-bid-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const amount = Number(input('#stake-bid-amount').value);
    if (Number.isInteger(amount)) send('game:stakeBid', { amount, allIn: false });
  });
  button('#stake-all-in').onclick = () => {
    const { you, participants } = activeState();
    const amount = participants.find((p) => p.id === you.id)?.score ?? 0;
    send('game:stakeBid', { amount, allIn: true });
  };
  button('#stake-pass').onclick = () => send('game:stakePass');

  let forAllQuestionKey: string | null = null;
  function renderForAll() {
    const { game, you, participants } = activeState();
    const phase = game.phase === 'paused' ? game.pausedPhase : game.phase;
    const forAll = game.forAll;
    const visible = game.current?.type === 'forAll' && !!forAll &&
      ['reading', 'forAllAnswering', 'forAllJudge'].includes(phase ?? '');
    $('#for-all').classList.toggle('hidden', !visible);
    if (!visible || !forAll || !game.current) {
      forAllQuestionKey = null;
      return;
    }

    const key = `${game.roundIndex}:${game.current.themeIndex}:${game.current.questionIndex}`;
    const answerInput = $('#for-all-answer') as HTMLTextAreaElement;
    if (forAllQuestionKey !== key) {
      answerInput.value = '';
      forAllQuestionKey = key;
    }
    const playerCount = forAll.eligibleIds.length;
    const submitted = forAll.submittedIds.filter((id) => forAll.eligibleIds.includes(id)).length;
    const judged = forAll.judgedIds.filter((id) => forAll.eligibleIds.includes(id)).length;
    $('#for-all-status').textContent = phase === 'reading'
      ? 'Read the question. Private answers open shortly.'
      : phase === 'forAllAnswering'
        ? `${submitted} of ${playerCount} players answered.${game.phase === 'paused' ? ' Paused.' : ''}`
        : `Answers closed. ${judged} of ${playerCount} players judged.`;

    const isPlayer = you.role === 'player';
    const hasSubmitted = forAll.submittedIds.includes(you.id);
    const canAnswer = game.phase === 'forAllAnswering' && isPlayer &&
      forAll.eligibleIds.includes(you.id) && !hasSubmitted;
    $('#for-all-answer-form').classList.toggle('hidden', !canAnswer);
    if (forAll.yourAnswer !== null) $('#for-all-status').textContent += ' Your answer is saved.';

    const host = you.canModerate;
    $('#for-all-host').classList.toggle('hidden', !host);
    const close = button('#for-all-close');
    close.classList.toggle('hidden', phase !== 'forAllAnswering');
    close.disabled = game.phase !== 'forAllAnswering';
    const list = $('#for-all-answers');
    const moveFocusAfterJudging = list.contains(document.activeElement);
    list.replaceChildren();
    if (!host || phase !== 'forAllJudge' || !forAll.answers) return;

    for (const player of participants.filter((p) => forAll.eligibleIds.includes(p.id))) {
      const row = document.createElement('div');
      row.className = 'for-all-response';
      const heading = document.createElement('strong');
      heading.textContent = player.name;
      const answer = document.createElement('p');
      answer.textContent = forAll.answers[player.id] || '(No answer submitted)';
      row.append(heading, answer);
      if (forAll.judgedIds.includes(player.id)) {
        const judged = document.createElement('span');
        judged.textContent = 'Judged';
        row.append(judged);
      } else {
        for (const [label, correct] of [['Correct', true], ['Wrong', false]] as const) {
          const judgeButton = document.createElement('button');
          judgeButton.type = 'button';
          judgeButton.className = correct ? 'ok' : 'bad';
          judgeButton.dataset.icon = correct ? 'check' : 'cross';
          judgeButton.textContent = label;
          judgeButton.setAttribute('aria-label', `${player.name}: mark answer ${correct ? 'correct' : 'wrong'}`);
          judgeButton.disabled = game.phase !== 'forAllJudge';
          judgeButton.onclick = () => send('game:judgeForAll', { playerId: player.id, correct });
          row.append(judgeButton);
        }
      }
      list.append(row);
    }
    // A verdict rerenders this list; keep keyboard focus on the next decision.
    if (moveFocusAfterJudging) list.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  $('#for-all-answer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = ($('#for-all-answer') as HTMLTextAreaElement).value.trim();
    if (answer) send('game:forAllAnswer', { answer });
  });
  button('#for-all-close').onclick = () => send('game:closeForAll');

  function renderAppeals() {
    const { game, you, participants, settings } = activeState();
    const phase = game.phase === 'paused' ? game.pausedPhase : game.phase;
    const appeals = game.appeals;
    const visible = !!appeals && (appeals.judgments.length > 0 || !!appeals.active) &&
      (phase === 'reveal' || phase === 'appealVote');
    $('#appeals').classList.toggle('hidden', !visible);
    if (!visible || !appeals) return;

    const nameOf = (id: string) => participants.find((p) => p.id === id)?.name ?? 'Player';
    const active = appeals.active;
    const voteOpen = game.phase === 'appealVote' && !!active;
    const voteActions = $('#appeal-vote-actions');
    const mayVote = voteOpen && active.eligibleVoterIds.includes(you.id) &&
      !active.votedIds.includes(you.id) && you.role === 'player';
    voteActions.classList.toggle('hidden', !mayVote);
    const close = button('#appeal-close');
    close.classList.toggle('hidden', !voteOpen || !you.canModerate);
    close.disabled = !voteOpen;

    if (active) {
      const challenge = active.kind === 'for' ? 'rejected answer' : 'accepted answer';
      const voted = active.votedIds.filter((id) => active.eligibleVoterIds.includes(id)).length;
      $('#appeal-status').textContent = `${nameOf(active.requesterId)} appealed ${nameOf(active.targetId)}’s ${challenge}. ` +
        `${voted} of ${active.eligibleVoterIds.length} votes received. Votes are private.` +
        (active.votedIds.includes(you.id) ? ' Your vote is saved.' : '') +
        (game.phase === 'paused' ? ' Paused.' : '');
    } else {
      $('#appeal-status').textContent = settings.useApellations
        ? 'Players may request a review before the next question.' : 'Appeals are disabled.';
    }

    const list = $('#appeal-judgments');
    list.replaceChildren();
    const connectedPlayers = participants.filter((p) => p.role === 'player' && p.connected).length;
    for (const judgment of appeals.judgments) {
      const row = document.createElement('div');
      row.className = 'appeal-judgment';
      const verdict = judgment.voided ? 'Voided' : judgment.correct ? 'Accepted' : 'Rejected';
      const shownDelta = judgment.voided ? 0 : judgment.delta;
      const delta = shownDelta > 0 ? `+${shownDelta}` : String(shownDelta);
      const label = document.createElement('span');
      label.textContent = `${nameOf(judgment.playerId)}: ${verdict} (${delta})${judgment.appealed ? ' · appeal reviewed' : ''}`;
      row.append(label);

      const targetIsPlayer = participants.some((p) => p.id === judgment.playerId && p.role === 'player');
      const ownRejected = !judgment.correct && judgment.playerId === you.id &&
        !(game.current?.type === 'forAll' && game.forAll?.yourAnswer === null);
      const challengeAccepted = judgment.correct && judgment.playerId !== you.id && connectedPlayers >= 4;
      if (game.phase === 'reveal' && settings.useApellations && you.role === 'player' &&
          targetIsPlayer && !judgment.appealed && !judgment.voided &&
          (ownRejected || challengeAccepted)) {
        const request = document.createElement('button');
        request.type = 'button';
        request.textContent = ownRejected ? 'Appeal rejection' : 'Challenge acceptance';
        request.setAttribute('aria-label', `${request.textContent} for ${nameOf(judgment.playerId)}`);
        request.onclick = () => send('game:appealRequest', { judgmentId: judgment.id });
        row.append(request);
      }
      list.append(row);
    }
    // Verdicts already show on the podiums; the panel appears only when someone can act on it.
    if (!active && !list.querySelector('button')) $('#appeals').classList.add('hidden');
  }

  button('#appeal-support').onclick = () => send('game:appealVote', { support: true });
  button('#appeal-oppose').onclick = () => send('game:appealVote', { support: false });
  button('#appeal-close').onclick = () => send('game:appealClose');

  function renderResults() {
    const { game, participants, you, pack } = activeState();
    const finished = game.phase === 'gameOver';
    $('#results').classList.toggle('hidden', !finished);
    if (!finished) return;

    const ranking = participants.filter((p) => p.role === 'player')
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const winners = ranking.filter((p) => p.score === ranking[0]?.score);
    $('#results-winner').textContent = winners.length > 1
      ? `Shared win: ${winners.map((p) => p.name).join(', ')}`
      : winners.length ? `${winners[0].name} wins` : 'No player scores.';
    const list = $('#results-list');
    list.replaceChildren();
    for (const player of ranking) {
      const item = document.createElement('li');
      item.classList.toggle('winner', winners.includes(player));
      item.append(avatar(player.id, player.name),
        Object.assign(document.createElement('span'), { className: 'name', textContent: player.name }),
        Object.assign(document.createElement('span'), { className: 'pts', textContent: formatScore(player.score) }));
      list.append(item);
    }

    const canRematch = !tvMode && you.canManage;
    const ready = !!pack && participants.some((p) => p.role === 'host' && p.connected) &&
      participants.some((p) => p.role === 'player' && p.connected);
    button('#btn-rematch').classList.toggle('hidden', !canRematch);
    button('#btn-rematch').disabled = !ready;
    $('#results-hint').textContent = canRematch
      ? ready ? 'A rematch starts from round one and resets scores.'
        : 'A connected host and player are needed for a rematch.'
      : 'Waiting for the host to start a rematch.';
  }

  button('#btn-rematch').onclick = () => {
    if (confirm('Start a rematch? Scores will reset.')) send('game:start');
  };

  function renderPlayers() {
    const state = activeState();
    const { participants, game, you } = state;
    const now = nowServer();
    const blockedMap = new Map((game.buzzer?.blockedPlayers ?? []).map((b) => [b.id, b.until]));
    const attemptedSet = new Set(game.buzzer?.attempted ?? []);
    const seats = $('#players');
    const hostSeat = $('#host-seat');
    // The host sits in the host column, like the show's presenter, not on the scoreboard.
    const hostInColumn = game.phase !== 'gameOver';

    // Snapshots rebuild seats; preserve open menus and a half-typed score change while scores change.
    const containers = [seats, hostSeat];
    const openMenus = new Set(containers.flatMap((box) =>
      Array.from(box.querySelectorAll<HTMLDetailsElement>('details[open]')).map((menu) => menu.dataset.playerId)));
    const drafts = new Map(containers.flatMap((box) =>
      Array.from(box.querySelectorAll<HTMLInputElement>('.score-form input')).map((field) =>
        [field.dataset.playerId ?? '', field.value] as const)));
    const focusedDraft = document.activeElement instanceof HTMLInputElement &&
      document.activeElement.closest('.score-form') ? document.activeElement.dataset.playerId : undefined;
    seats.replaceChildren();
    hostSeat.replaceChildren();

    for (const p of participants) {
      // TV connections are display devices, not contestants on the scoreboard.
      if (p.displayOnly && game.phase !== 'lobby') continue;
      const el = document.createElement('div');
      el.className = 'player';
      el.classList.add(`role-${p.role}`);
      if (p.id === you.id) el.classList.add('you');
      if (!p.connected) el.classList.add('off');
      const isChooser = p.id === game.chooserId && (game.phase === 'board' || game.phase === 'finalThemes');
      if (isChooser) el.classList.add('chooser');

      const isAnswering = p.id === game.buzzer.winnerId && game.phase === 'answering';
      const blockedUntil = blockedMap.get(p.id) ?? 0;
      const isBlocked = blockedUntil > now;
      const hasTried = attemptedSet.has(p.id);

      if (isAnswering) el.classList.add('answering');
      else if (isBlocked) el.classList.add('blocked');
      else if (hasTried) el.classList.add('tried');

      const name = Object.assign(document.createElement('b'), { textContent: p.name, title: p.name });
      el.append(avatar(p.id, p.name), name);
      if (p.role === 'player') {
        el.append(Object.assign(document.createElement('div'), {
          className: `score${p.score < 0 ? ' negative' : ''}`, textContent: formatScore(p.score),
        }));
      } else {
        el.append(Object.assign(document.createElement('span'), { className: 'role-label', textContent: roleLabels[p.role] ?? p.role }));
      }
      const slot = document.createElement('div');
      slot.className = 'badge-slot';
      const badge = (className: string, text: string) =>
        slot.append(Object.assign(document.createElement('span'), { className: `badge ${className}`, textContent: text }));
      if (!p.connected) badge('off-badge', 'Offline');
      else if (isAnswering) badge('answering-badge', state.settings.oral ? 'Answering' : 'Writing');
      else if (isBlocked) badge('blocked-badge', `Blocked ${Math.max(1, Math.ceil((blockedUntil - now) / 1000))}s`);
      else if (hasTried) badge('tried-badge', 'Answered');
      else if (isChooser) badge('chooser-badge', game.phase === 'finalThemes' ? 'Removes' : 'Picks');
      el.append(slot);
      // Final answers are judged on each podium, next to the answer and wager they belong to.
      const final = game.final;
      if (you.canModerate && game.phase === 'finalJudge' && final?.eligibleIds.includes(p.id)) {
        el.classList.add('judging');
        el.append(finalVerdict(p.id, p.name, final));
      }
      const replic = replicFor(p.id);
      if (replic) el.append(replic);

      const actions = document.createElement('details');
      actions.className = 'player-menu';
      actions.dataset.playerId = p.id;
      actions.open = openMenus.has(p.id);
      const summary = document.createElement('summary');
      summary.textContent = '⋮';
      summary.setAttribute('aria-label', `Manage ${p.name}`);
      // Menu items live in a popover panel so opening one never reshapes the podium row.
      const panel = Object.assign(document.createElement('div'), { className: 'player-menu-panel' });
      // Naming the person keeps the menu readable when it floats over the board.
      panel.append(Object.assign(document.createElement('strong'), { className: 'menu-title', textContent: p.name }));
      actions.append(summary, panel);
      if (you.canModerate && p.role === 'player') {
        const row = document.createElement('div');
        row.className = 'row';
        const plus = Object.assign(document.createElement('button'), { type: 'button', textContent: '+100' });
        const minus = Object.assign(document.createElement('button'), { type: 'button', textContent: '−100' });
        plus.onclick = () => send('score:adjust', { targetId: p.id, delta: 100 });
        minus.onclick = () => send('score:adjust', { targetId: p.id, delta: -100 });
        plus.setAttribute('aria-label', `Add 100 points to ${p.name}`);
        minus.setAttribute('aria-label', `Subtract 100 points from ${p.name}`);
        row.append(plus, minus);
        // An inline field replaces the old prompt() so the host never loses sight of the board.
        const form = Object.assign(document.createElement('form'), { className: 'score-form' });
        const field = Object.assign(document.createElement('input'), {
          type: 'number', step: '1', placeholder: '±250', value: drafts.get(p.id) ?? '',
        });
        field.dataset.playerId = p.id;
        field.setAttribute('aria-label', `Custom score change for ${p.name}`);
        const apply = Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Apply' });
        form.append(field, apply);
        form.onsubmit = async (event) => {
          event.preventDefault();
          const delta = Number(field.value.trim());
          if (!field.value.trim() || !Number.isSafeInteger(delta) || delta === 0) {
            toast('Enter a whole-number score change, for example -250 or 350.');
            return;
          }
          if ((await send('score:adjust', { targetId: p.id, delta })).ok) field.value = '';
        };
        panel.append(row, form);
        if (focusedDraft === p.id) queueMicrotask(() => field.focus());
      }
      if (you.canModerate && p.id !== you.id) {
        const kick = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove from room' });
        kick.className = 'bad';
        kick.dataset.icon = 'cross';
        kick.setAttribute('aria-label', `Remove ${p.name} from the room`);
        kick.onclick = () => {
          if (confirm(`Remove ${p.name} from the room?`)) send('participant:kick', { targetId: p.id });
        };
        panel.append(kick);
      }
      const vacantHostSeat = !participants.some((member) => member.role === 'host');
      const canAppoint = state.game.phase === 'lobby'
        ? p.role === 'player' || p.role === 'spectator'
        : p.role === 'spectator';
      if (you.canModerate && vacantHostSeat && p.connected && !p.displayOnly && p.id !== you.id && canAppoint) {
        const appoint = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Make host' });
        appoint.setAttribute('aria-label', `Make ${p.name} host`);
        appoint.onclick = () => send('role:set', { targetId: p.id, role: 'host' });
        panel.append(appoint);
      }
      if (you.canModerate && p.role === 'host' && !p.connected) {
        const release = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Release host seat' });
        release.setAttribute('aria-label', `Release ${p.name} from the host seat`);
        release.onclick = () => send('role:set', { targetId: p.id, role: 'spectator' });
        panel.append(release);
      }
      if (panel.children.length > 1) el.append(actions);
      (hostInColumn && p.role === 'host' ? hostSeat : seats).append(el);
    }
    // Before the game, open seats show how many more people can still join as players.
    if (game.phase === 'lobby') {
      const free = state.settings.maxPlayers - participants.filter((p) => p.role === 'player').length;
      for (let i = 0; i < free; i++) {
        const seat = Object.assign(document.createElement('div'), { className: 'player empty-seat' });
        seat.setAttribute('aria-label', 'Free player seat');
        seat.append(Object.assign(document.createElement('span'), { className: 'avatar', textContent: '+' }),
          Object.assign(document.createElement('b'), { textContent: 'Free seat' }),
          Object.assign(document.createElement('span'), { className: 'role-label', textContent: 'Scan the code to join' }));
        seats.append(seat);
      }
    }
  }

  function finalVerdict(playerId: string, name: string, final: NonNullable<RoomState['game']['final']>): HTMLElement {
    const box = Object.assign(document.createElement('div'), { className: 'podium-verdict' });
    const answer = final.answers?.[playerId];
    box.append(Object.assign(document.createElement('p'), {
      className: answer ? 'final-text' : 'final-text empty', textContent: answer || 'No written answer', title: answer ?? '',
    }));
    const wager = final.wagers?.[playerId];
    if (wager != null) box.append(Object.assign(document.createElement('small'), { textContent: `Wager ${formatScore(wager)}` }));
    if (final.judged.includes(playerId)) return box;
    const row = Object.assign(document.createElement('div'), { className: 'verdict-buttons' });
    const verdict = (correct: boolean) => {
      const b = Object.assign(document.createElement('button'), {
        type: 'button', className: correct ? 'ok' : 'bad', textContent: correct ? '✓' : '✗',
      });
      b.setAttribute('aria-label', `${correct ? 'Correct' : 'Wrong'}: ${name}`);
      b.onclick = () => send('game:judgeFinal', { playerId, correct });
      return b;
    };
    row.append(verdict(true), verdict(false));
    box.append(row);
    return box;
  }

  // Wide screens list the scoreboard down the host column; elsewhere it sits under the table.
  const sideScoreboard = matchMedia('(min-width: 861px) and (min-height: 620px)');
  function placeScoreboard() {
    const target = sideScoreboard.matches ? $('.host-col') : $('#screen-game');
    if ($('#players').parentElement !== target) target.append($('#players'));
  }
  sideScoreboard.addEventListener('change', placeScoreboard);
  placeScoreboard();
  applyVolume();

  // Popover menus close when the user clicks elsewhere, like any menu.
  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>('.player-menu[open]')) {
      if (!menu.contains(event.target as Node)) menu.open = false;
    }
  });

  /* ---------------- lobby settings & packs ---------------- */

  const numberSettingKeys = [
    'maxPlayers', 'timeForBlockingButton', 'buzzSyncWindowMs', 'readingSpeed', 'timeForThinkingOnQuestion',
    'timeForPrintingAnswer', 'timeForMakingStake', 'timeForThinkingOnSpecial',
    'timeForFinalThinking', 'timeOfRound', 'timeForQuestionIntro',
  ] as const;
  let packsLoaded = false;
  let knownPacks: PackListItem[] = [];
  let renderedPackName: string | null | undefined;
  async function refreshPacks() {
    const res = await send('packs:list');
    if (!res.ok) return;
    knownPacks = res.packs ?? [];
    renderPackList();
  }

  // Pack rows show the loaded pack as current, so the host can see what will play at a glance.
  function renderPackList() {
    const loaded = state?.pack?.name ?? null;
    renderedPackName = loaded;
    const list = $('#pack-list');
    list.replaceChildren();
    if (!knownPacks.length) {
      list.append(Object.assign(document.createElement('li'), {
        className: 'hint', textContent: 'No packs yet. Add a .siq file below or put one in the packs folder.',
      }));
      return;
    }
    for (const p of knownPacks) {
      const li = document.createElement('li');
      const current = !p.error && p.name === loaded;
      li.classList.toggle('current', current);
      const meta = Object.assign(document.createElement('div'), { className: 'pack-meta' });
      const rounds = p.rounds == null ? 'Rounds unknown' : `${p.rounds} round${p.rounds === 1 ? '' : 's'}`;
      meta.append(Object.assign(document.createElement('strong'), { textContent: p.name }),
        Object.assign(document.createElement('span'), { textContent: `${rounds} · ${(p.size / 1e6).toFixed(1)} MB` }));
      if (p.error) meta.append(Object.assign(document.createElement('span'), { className: 'error', textContent: p.error }));
      const btn = Object.assign(document.createElement('button'), {
        type: 'button', className: 'small', textContent: current ? 'Loaded' : 'Load',
      });
      btn.disabled = !!p.error || current;
      btn.setAttribute('aria-label', p.error ? `${p.name} unavailable: ${p.error}` : `Load ${p.name}`);
      btn.onclick = () => send('packs:load', { file: p.file });
      li.append(meta, btn);
      list.append(li);
    }
  }

  // The server knows its LAN address; the browser only knows how it reached the host.
  let inviteLoaded = false;
  async function loadInvite() {
    inviteLoaded = true;
    let url = location.origin;
    try {
      const info = await (await fetch('/api/info')).json() as { urls?: string[] };
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') url = info.urls?.[0] ?? url;
    } catch { /* The current origin still works for devices that reached this page. */ }
    $('#invite-url').textContent = url;
    ($('#tv-link') as HTMLAnchorElement).href = `${url}/?tv`;
    // Phones join by pointing the camera at the screen instead of typing the address.
    const qr = $('#invite-qr') as HTMLImageElement;
    qr.src = `/api/invite.svg?url=${encodeURIComponent(url)}`;
    qr.classList.remove('hidden');
  }
  button('#btn-copy-invite').onclick = async () => {
    const url = $('#invite-url').textContent ?? '';
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied.', 'info');
    } catch {
      // Clipboard needs a secure context; selecting the text lets the host copy it by hand.
      getSelection()?.selectAllChildren($('#invite-url'));
      toast('Press Ctrl+C or Cmd+C to copy the selected link.', 'info');
    }
  };
  $('#btn-refresh-packs').addEventListener('click', refreshPacks);

  $('#pack-upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const picker = input('#pack-upload-file');
    const file = picker.files?.[0];
    const status = $('#pack-upload-status');
    if (!file || !/\.siq$/i.test(file.name)) {
      status.textContent = 'Choose a .siq pack file.';
      return;
    }
    if (!file.size || file.size > 200 * 1024 * 1024) {
      status.textContent = 'The pack must be between 1 byte and 200 MB.';
      return;
    }
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      status.textContent = 'Reconnect to the room before uploading.';
      return;
    }

    const submit = button('#pack-upload-button');
    const progress = $('#pack-upload-progress') as HTMLProgressElement;
    submit.disabled = true;
    picker.disabled = true;
    progress.classList.remove('hidden');
    progress.value = 0;
    status.textContent = `Uploading ${file.name}…`;
    try {
      // XHR exposes byte progress for large local packs; fetch does not.
      const uploaded = await new Promise<{ file: string; name: string }>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/api/packs/upload');
        request.responseType = 'json';
        request.setRequestHeader('Content-Type', 'application/octet-stream');
        request.setRequestHeader('X-Pack-Name', encodeURIComponent(file.name));
        request.setRequestHeader('Authorization', `Bearer ${token}`);
        request.upload.onprogress = ({ loaded, lengthComputable, total }) => {
          if (!lengthComputable) return;
          progress.value = Math.min(100, Math.round(100 * loaded / total));
          status.textContent = `Uploading ${file.name}: ${progress.value}%`;
        };
        request.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
        request.onload = () => {
          const body = request.response as { file?: string; name?: string; error?: string } | null;
          if (request.status < 200 || request.status >= 300 || !body?.file) {
            reject(new Error(body?.error || `Upload failed (${request.status}).`));
          } else {
            resolve({ file: body.file, name: body.name || body.file });
          }
        };
        request.send(file);
      });
      progress.value = 100;
      picker.value = '';
      await refreshPacks();
      if (state?.game.phase === 'lobby' && state.you?.canManage) {
        const result = await send('packs:load', { file: uploaded.file });
        status.textContent = result.ok ? `Uploaded and loaded ${uploaded.name}.`
          : `Uploaded ${uploaded.name}. Select it from the pack list to load it.`;
      } else {
        status.textContent = `Uploaded ${uploaded.name}. Load it before the next game.`;
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Upload failed.';
    } finally {
      picker.disabled = false;
      submit.disabled = false;
    }
  });

  let settingsOpen = false;
  const setSettingsOpen = (open: boolean) => {
    settingsOpen = open;
    if (hasActivePlayer(state)) renderManage();
  };
  button('#btn-settings').onclick = () => setSettingsOpen(!settingsOpen);
  button('#btn-close-settings').onclick = () => setSettingsOpen(false);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsOpen) setSettingsOpen(false);
  });

  function renderManage() {
    const state = activeState();
    // During a game the host opens the same settings as a drawer; pack and start stay in the lobby.
    const inGame = state.game.phase !== 'lobby';
    const showManage = state.you.canManage && (!inGame || settingsOpen);
    $('#manage').classList.toggle('hidden', !showManage);
    $('#manage').classList.toggle('in-game', inGame);
    button('#btn-close-settings').classList.toggle('hidden', !inGame);
    button('#btn-settings').setAttribute('aria-expanded', String(settingsOpen && inGame));
    if (!showManage) return;
    // The server refuses switching answer mode mid-game, so the toggle says so up front.
    input('#set-oral').disabled = inGame;

    if (!packsLoaded) {
      packsLoaded = true;
      refreshPacks();
    }
    if (renderedPackName !== (state.pack?.name ?? null)) renderPackList();
    const current = $('#pack-current');
    current.classList.toggle('empty', !state.pack);
    current.replaceChildren();
    if (state.pack) {
      const rounds = state.pack.rounds.length;
      current.append(Object.assign(document.createElement('strong'), { textContent: state.pack.name }),
        Object.assign(document.createElement('span'), {
          textContent: `${state.pack.stats.questions} questions · ${rounds} round${rounds === 1 ? '' : 's'}`,
        }));
    } else current.textContent = 'No pack loaded. Pick one from the list.';

    // A checklist says exactly what is missing instead of one vague disabled button.
    const hasHost = state.participants.some((p) => p.role === 'host' && p.connected);
    const playerCount = state.participants.filter((p) => p.role === 'player' && p.connected).length;
    const checks: [boolean, string][] = [
      [!!state.pack, state.pack ? 'Pack loaded' : 'Load a pack'],
      [hasHost, hasHost ? 'Host connected' : 'Appoint a connected host'],
      [playerCount > 0, playerCount ? `${playerCount} player${playerCount === 1 ? '' : 's'} ready` : 'Wait for a player'],
    ];
    const checklist = $('#start-checklist');
    checklist.replaceChildren(...checks.map(([done, text]) =>
      Object.assign(document.createElement('li'), { className: done ? 'done' : '', textContent: text })));
    const ready = checks.every(([done]) => done);
    button('#btn-start').disabled = !ready;
    $('#start-hint').textContent = !hasHost
      ? 'Open a participant’s Manage menu and choose Make host.' : '';

    // Sync settings inputs
    const s = state.settings;
    if (document.activeElement !== select('#set-gameMode')) select('#set-gameMode').value = s.gameMode;
    if (document.activeElement !== input('#set-falseStart')) input('#set-falseStart').checked = s.falseStart;
    $('#set-falseStart-desc').textContent = s.falseStart
      ? `Pressing before the signal blocks the button for ${s.timeForBlockingButton} s.`
      : 'Players can buzz while the question is still being read.';

    if (document.activeElement !== select('#set-buzzSyncMode')) {
      select('#set-buzzSyncMode').value = s.buzzSyncMode;
    }
    $('#set-buzzSyncMode-desc').textContent = s.buzzSyncMode === 'clientTimestamp'
      ? `Presses within ${s.buzzSyncWindowMs} ms are compared by device time. Fairer on mixed Wi‑Fi.`
      : 'Simplest. A slower connection can lose a close press.';

    for (const key of numberSettingKeys) {
      const field = input(`#set-${key}`);
      if (document.activeElement !== field) field.value = String(s[key]);
      if (key === 'timeForBlockingButton') field.disabled = !s.falseStart;
      if (key === 'buzzSyncWindowMs') field.disabled = s.buzzSyncMode !== 'clientTimestamp';
    }
    if (document.activeElement !== $('#set-ignoreWrong')) {
      input('#set-ignoreWrong').checked = s.ignoreWrong;
    }
    if (document.activeElement !== $('#set-partialText')) {
      input('#set-partialText').checked = s.partialText;
    }
    if (document.activeElement !== $('#set-oral')) {
      input('#set-oral').checked = s.oral;
    }
    if (document.activeElement !== $('#set-playAllQuestionsInFinalRound')) {
      input('#set-playAllQuestionsInFinalRound').checked = s.playAllQuestionsInFinalRound;
    }
    if (document.activeElement !== $('#set-useApellations')) {
      input('#set-useApellations').checked = s.useApellations;
    }
  }

  // Settings change listeners
  select('#set-gameMode').addEventListener('change', () => send('settings:update', { gameMode: select('#set-gameMode').value }));
  select('#set-buzzSyncMode').addEventListener('change', () =>
    send('settings:update', { buzzSyncMode: select('#set-buzzSyncMode').value as RoomState['settings']['buzzSyncMode'] }));
  input('#set-falseStart').addEventListener('change', () => {
    send('settings:update', { falseStart: input('#set-falseStart').checked });
  });
  input('#set-ignoreWrong').addEventListener('change', () => {
    send('settings:update', { ignoreWrong: input('#set-ignoreWrong').checked });
  });
  input('#set-partialText').addEventListener('change', () => {
    send('settings:update', { partialText: input('#set-partialText').checked });
  });
  input('#set-oral').addEventListener('change', () => {
    send('settings:update', { oral: input('#set-oral').checked });
  });
  input('#set-playAllQuestionsInFinalRound').addEventListener('change', () => {
    send('settings:update', { playAllQuestionsInFinalRound: input('#set-playAllQuestionsInFinalRound').checked });
  });
  input('#set-useApellations').addEventListener('change', () => {
    send('settings:update', { useApellations: input('#set-useApellations').checked });
  });
  for (const key of numberSettingKeys) {
    input(`#set-${key}`).addEventListener('change', () => {
      const val = Number.parseInt(input(`#set-${key}`).value, 10);
      if (Number.isFinite(val)) send('settings:update', { [key]: val });
    });
  }

  /* ---------------- board & question ---------------- */

  // The pick intro is a phase of its own; while it is paused the board must keep the lit cell too.
  const isIntro = (game: RoomState['game']) => game.phase === 'intro' ||
    (game.phase === 'paused' && game.pausedPhase === 'intro');
  const roundTitle = (name: string) => /^\d+$/.test(name.trim()) ? `Round ${name.trim()}` : name;

  /*
   * Round entrance, played when a round starts or the host switches to one (not on reload):
   * the title card swells in, then the cells light up in a diagonal wave. The board is rebuilt on
   * every state update, so the wave is timed from the entrance start rather than from each rebuild.
   */
  const ROUND_ENTER_MS = 2200;
  let lastRoundIndex: number | undefined;
  let roundEnterAt = 0;
  function noteRoundChange(game: RoomState['game']) {
    const previous = lastRoundIndex;
    lastRoundIndex = game.roundIndex;
    if (previous === undefined || previous === game.roundIndex || !game.round) return;
    roundEnterAt = Date.now();
    const splash = $('#round-splash');
    splash.textContent = roundTitle(game.round.name);
    splash.classList.remove('show');
    void splash.offsetWidth; // Restart the animation when rounds switch quickly.
    splash.classList.add('show');
  }

  function renderBoard() {
    const state = activeState();
    const { game, you } = state;
    const board = $('#board');
    board.innerHTML = '';
    noteRoundChange(game);
    const entering = Date.now() - roundEnterAt < ROUND_ENTER_MS;
    board.classList.toggle('round-enter', entering);
    board.style.setProperty('--elapsed', `${Date.now() - roundEnterAt}ms`);
    let waveIndex = 0;
    const wave = (el: HTMLElement, step: number) => { el.style.setProperty('--d', `${520 + step * 28}ms`); };
    const lobby = game.phase === 'lobby';
    $('#lobby-table').classList.toggle('hidden', !lobby);
    if (lobby && !inviteLoaded) void loadInvite();
    board.classList.toggle('final-themes', game.phase === 'finalThemes');
    if (game.phase === 'finalThemes') {
      board.style.gridTemplateColumns = 'repeat(auto-fit, minmax(200px, 1fr))';
      const canRemove = you.canModerate || you.id === game.chooserId;
      game.board.forEach((theme, index) => {
        if (game.removedFinalThemes.includes(index) || !theme.questions[0]?.available) return;
        const el = document.createElement(canRemove ? 'button' : 'div');
        el.className = 'theme';
        el.textContent = theme.name;
        wave(el, waveIndex++ * 3);
        if (canRemove) {
          el.setAttribute('type', 'button');
          el.setAttribute('aria-label', `Remove theme ${theme.name}`);
          el.append(Object.assign(document.createElement('small'), { textContent: 'Remove' }));
          el.onclick = () => send('game:removeFinalTheme', { themeIndex: index });
        }
        board.append(el);
      });
      return;
    }
    // During the intro the board stays up with the chosen cell flashing, like the show.
    const intro = isIntro(game);
    if (game.phase !== 'board' && !intro) {
      // Between questions the table shows where the game stands instead of disappearing.
      if (game.current || !game.round) return;
      board.style.gridTemplateColumns = '1fr';
      const card = Object.assign(document.createElement('div'), { className: 'table-title' });
      const caption = game.phase === 'roundEnd' ? 'Round complete'
        : game.phase === 'finalWager' ? 'Final wagers' : game.phase === 'paused' ? 'Paused' : '';
      card.append(Object.assign(document.createElement('strong'), { textContent: game.round.name }));
      if (caption) card.append(Object.assign(document.createElement('span'), { textContent: caption }));
      board.append(card);
      return;
    }
    const cols = Math.max(...game.board.map((t) => t.questions.length), 1);
    // Columns and rows come from CSS so the price font can follow the cell size, not the window.
    board.style.gridTemplateColumns = '';
    board.style.setProperty('--cols', String(cols));
    board.style.setProperty('--rows', String(game.board.length));
    board.style.setProperty('--phone-cols', String(Math.min(cols, 5)));
    const canPick = !intro && (you.canModerate || you.id === game.chooserId);
    // The pick blink is timed from the server's intro start, so a rebuilt board continues it instead of
    // restarting, and every screen blinks in step. A paused intro shows the steady lit cell.
    const t0 = game.timer?.name === 'intro' ? game.timer.endsAt - game.timer.durationMs : null;
    board.style.setProperty('--pick-elapsed', `${t0 == null ? 60000 : Math.max(0, nowServer() - t0)}ms`);
    board.classList.toggle('has-pick', intro);
    const pickLabel = intro && game.current ? questionTypeLabel(game.current.type) : '';
    const shrinkInto = game.phase === 'board' && lastPick?.round === game.roundIndex ? lastPick : null;
    game.board.forEach((theme, t) => {
      const title = Object.assign(document.createElement('div'), { className: 'theme', textContent: theme.name, title: theme.name });
      if (intro && game.current?.themeIndex === t) title.classList.add('chosen-theme');
      // Hyphenation needs the text's language; packs here are mostly Russian or English.
      title.lang = /[А-Яа-яЁё]/.test(theme.name) ? 'ru' : 'en';
      wave(title, t);
      board.append(title);
      for (let q = 0; q < cols; q++) {
        const cell = theme.questions[q];
        const el = document.createElement(cell?.available && canPick ? 'button' : 'div');
        const chosen = intro && game.current?.themeIndex === t && game.current?.questionIndex === q;
        el.className = 'cell' + (chosen ? ' chosen' : cell?.available ? '' : ' used');
        if (shrinkInto?.theme === t && shrinkInto.question === q) el.classList.add('pick-target');
        wave(el, t + q + 1);
        // A special question names its twist on the lit cell, so the room hears it before the question.
        el.textContent = chosen && pickLabel ? pickLabel : String(cell?.price ?? '');
        if (cell && !cell.available && !chosen) el.setAttribute('aria-label', `${theme.name}, ${cell.price}, played`);
        if (cell?.available && canPick) {
          el.setAttribute('type', 'button');
          el.setAttribute('aria-label', `${theme.name}, ${cell.price} points`);
          el.onclick = () => send('game:select', { themeIndex: t, questionIndex: q });
        }
        board.append(el);
      }
    });
  }

  function createMediaPlayer(type: 'audio' | 'video', url: string,
    previous?: { paused: boolean; currentTime: number }, autoStart = true) {
    const wrap = document.createElement('div');
    wrap.className = 'media-wrap';

    const el = document.createElement(type);
    // Pack media starts with the question; show a tap button only if autoplay is blocked.
    el.preload = 'auto';
    routeThroughVolume(el, url);
    el.autoplay = autoStart && state?.game.phase !== 'paused' &&
      state?.game.phase !== 'answering' && !previous?.paused;
    if (el instanceof HTMLVideoElement) {
      // Required for iPhone / iPad Safari inline playback
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
    }
    el.src = url;
    // A rotated media ticket should not restart a clip the viewer paused or reset its position.
    if (previous?.paused) manuallyPausedMedia.add(el);
    if (previous && previous.currentTime > 0) {
      el.addEventListener('loadedmetadata', () => {
        try { el.currentTime = previous.currentTime; } catch { /* Some streams cannot seek. */ }
      }, { once: true });
    }
    el.addEventListener('pause', () => {
      if (gamePausedMedia.delete(el)) return;
      manuallyPausedMedia.add(el);
      el.autoplay = false;
    });
    el.addEventListener('play', () => manuallyPausedMedia.delete(el));
    wrap.append(el);

    const status = document.createElement('div');
    status.className = 'media-status hidden';
    wrap.append(status);

    // Explicitly invoke .play() and handle iOS Safari autoplay restrictions
    const canAutoPlay = () => autoStart && el.isConnected &&
      state?.game.phase !== 'paused' && state?.game.phase !== 'answering' &&
      !manuallyPausedMedia.has(el);
    const tryPlay = () => {
      // Delayed metadata and promise callbacks must respect game and manual pauses.
      if (!canAutoPlay()) return;
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          status.classList.add('hidden');
        }).catch(() => {
          if (!canAutoPlay()) return;
          // iOS Safari blocked unmuted autoplay -> fall back to muted autoplay + unmute button
          if (type === 'video' && !el.muted) {
            el.muted = true;
            el.play()
              .then(() => {
                status.className = 'media-status';
                status.innerHTML = '';
                const btn = Object.assign(document.createElement('button'), {
                  type: 'button',
                  className: 'media-tap-btn',
                  textContent: '🔇 Tap to unmute',
                });
                btn.onclick = () => {
                  el.muted = false;
                  el.play().catch(() => {});
                  status.classList.add('hidden');
                };
                status.append(btn);
              })
              .catch(() => { if (canAutoPlay()) showTapToPlay(); });
          } else {
            showTapToPlay();
          }
        });
      }
    };

    const showTapToPlay = () => {
      status.className = 'media-status';
      status.innerHTML = '';
      const btn = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'media-tap-btn',
        textContent: type === 'video' ? '▶️ Play video' : '▶️ Play audio',
      });
      btn.onclick = () => {
        el.muted = false;
        el.play()
          .then(() => status.classList.add('hidden'))
          .catch(() => {});
      };
      status.append(btn);
    };

    // Attempt playback as soon as metadata or data arrives
    if (autoStart) {
      el.addEventListener('loadedmetadata', tryPlay, { once: true });
      setTimeout(tryPlay, 50);
    }

    return wrap;
  }

  function contentElement(it: ContentItem,
    previous?: { paused: boolean; currentTime: number }, autoStart = true): HTMLElement {
    // Pictures sit in a ratio-keeping frame so pins and the answer ring land on the right pixel.
    if (it.type === 'image' && it.url) return imageFrame(it.url);
    if ((it.type === 'audio' || it.type === 'video') && it.url) {
      return createMediaPlayer(it.type, it.url, previous, autoStart);
    }
    if (it.type === 'html' && it.url) {
      // Pack HTML stays in a sandbox; its ticketed path lets relative assets load.
      const frame = document.createElement('iframe');
      frame.className = 'question-html';
      frame.title = 'Question HTML content';
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.referrerPolicy = 'no-referrer';
      frame.src = it.url;
      frame.addEventListener('load', syncQuestionMedia);
      return frame;
    }
    return Object.assign(document.createElement('p'), {
      textContent: it.missing ? `[missing ${it.type}: ${it.value}]` : it.value,
    });
  }

  let renderedQuestionKey: string | null = null;
  let questionPresenter: ContentPresenter<ContentItem> | null = null;
  let presenterId: string | null = null;
  let presenterFinishedId: string | null = null;
  let presenterAckingId: string | null = null;
  // Set when the question's last clip has played to the end on this device.
  let mediaEndedId: string | null = null;
  let previousContentMedia = new Map<number, { paused: boolean; currentTime: number }>();
  // A tapped but unsent picture answer survives re-renders until the player submits it.
  let pendingPick: { presentationId: string; x: number; y: number } | null = null;

  /*
   * The question card has fixed rows and never scrolls: a small meta line, the pinned prompt,
   * the media row that takes all spare height, then options, actions and the host strip.
   * Text items always go to the prompt, so it never disappears while pictures change.
   */
  interface StageSlots { box: HTMLElement; prompt: HTMLElement; media: HTMLElement; background: HTMLElement }
  let stageSlots: StageSlots | null = null;
  // Point questions draw pins on the picture; the presenter may place that picture later.
  let decorateStage: (() => void) | null = null;
  // The card keeps its size, but a window resize changes it, so the prompt is refitted then.
  new ResizeObserver(() => { if (stageSlots) fitText(stageSlots.prompt); }).observe($('#question'));
  const ANSWER_INDEX = 1000; // Keeps answer media apart from question media in the restore map.

  const isTextItem = (item: ContentItem) => (item.type === 'text' || item.type === 'say') && !item.missing;
  const slotFor = (item: ContentItem): 'prompt' | 'media' | 'background' =>
    isTextItem(item) ? 'prompt'
      : item.type === 'audio' || item.placement === 'background' ? 'background' : 'media';

  function buildStage(box: HTMLElement): StageSlots {
    const make = (className: string) => Object.assign(document.createElement('div'), { className });
    const slots = { box, prompt: make('q-prompt'), media: make('q-media'), background: make('q-background') };
    box.append(slots.prompt, slots.media, slots.background);
    return slots;
  }

  function placeContent(slots: StageSlots, item: ContentItem, index: number, autoStart: boolean): HTMLElement {
    const target = slotFor(item);
    const slot = slots[target];
    if (target === 'media') {
      // Each picture or clip replaces the previous one, as the pack's script intends.
      slot.querySelectorAll<HTMLMediaElement>('audio, video').forEach((clip) => clip.pause());
      slot.replaceChildren();
      setBackdrop(slot, item.type === 'image' ? item.url : null);
    }
    const wrapper = Object.assign(document.createElement('div'), { className: 'slot-item' });
    wrapper.dataset.contentIndex = String(index);
    const previous = previousContentMedia.get(index);
    previousContentMedia.delete(index);
    // A non-blocking background track may still be playing when its ticket rotates.
    const resumeBackground = target === 'background' && previous?.paused === false;
    const element = contentElement(item, previous, autoStart || resumeBackground);
    wrapper.append(element);
    slot.append(wrapper);
    syncStageShape(slots);
    if (target === 'media') decorateStage?.();
    return element;
  }

  function syncStageShape(slots: StageSlots) {
    const sound = () => [...slots.background.querySelectorAll<HTMLMediaElement>('audio, video')];
    // Audio has nothing to look at, so an empty media row shows that sound is playing.
    if (!slots.media.querySelector('.slot-item') && sound().length && !slots.media.querySelector('.audio-cue')) {
      slots.media.append(audioCue(sound));
    }
    slots.box.classList.toggle('has-media', slots.media.childElementCount > 0);
    slots.box.classList.toggle('has-prompt', slots.prompt.childElementCount > 0);
    requestAnimationFrame(() => fitText(slots.prompt));
  }

  function acknowledgePresentedContent() {
    if (!state?.you?.canModerate || state.game.phase !== 'reading' || !socket.connected) return;
    const current = state.game.current;
    if (!current || presenterFinishedId !== current.presentationId ||
        presenterAckingId === current.presentationId) return;
    // Blocking clips end the script themselves; other clips count once the last one has played out.
    const isClip = (item: ContentItem) => item.type === 'audio' || item.type === 'video';
    const blocking = current.content.some((item) => isClip(item) && item.waitForFinish);
    if (!blocking && !(current.content.some(isClip) && mediaEndedId === current.presentationId)) return;
    presenterAckingId = current.presentationId;
    socket.emit('game:contentFinished', { presentationId: current.presentationId }, () => {
      presenterAckingId = null;
    });
  }

  function renderOrderedContent(item: ContentItem, index: number, active: boolean,
    _replay: boolean, done: () => void) {
    if (!stageSlots) return;
    const slots = stageSlots;
    const element = placeContent(slots, item, index, active);
    if (active && isTextItem(item)) {
      // The presenter controls timing; updating one text node avoids restarting this item.
      return (visibleText: string) => { element.textContent = visibleText; fitText(slots.prompt); };
    }
    const clip = element.querySelector<HTMLMediaElement>('audio, video');
    const content = activeState().game.current?.content ?? [];
    const lastClip = content.reduce((last, entry, i) => entry.type === 'audio' || entry.type === 'video' ? i : last, -1);
    if (active && clip && index === lastClip) {
      const id = presenterId;
      const ended = () => { mediaEndedId = id; acknowledgePresentedContent(); };
      clip.addEventListener('ended', ended, { once: true });
      clip.addEventListener('error', ended, { once: true });
    }
    if (active && (item.type === 'audio' || item.type === 'video') && item.waitForFinish) {
      const media = element.querySelector<HTMLMediaElement>('audio, video');
      if (media) {
        media.addEventListener('ended', done, { once: true });
        media.addEventListener('error', done, { once: true });
      } else queueMicrotask(done); // A missing pack asset must not trap the game in reading.
    }
  }

  /** After reading, the card shows the final state of the script: every text and the last picture. */
  function renderStaticContent(slots: StageSlots, items: ContentItem[]) {
    items.forEach((item, index) => {
      if (slotFor(item) === 'media' && items.slice(index + 1).some((later) => slotFor(later) === 'media')) return;
      placeContent(slots, item, index, false);
    });
  }

  type CurrentQuestion = NonNullable<RoomState['game']['current']>;

  function answerTitle(c: CurrentQuestion): string {
    const right = c.right ?? [];
    if (c.answerType === 'select') return right.map((label) => optionText(c.answerOptions, label)).join(' / ');
    if (c.answerType === 'point') return '';
    return right.join(' / ');
  }

  /** At reveal the answer takes the question's place instead of piling up under it. */
  function renderAnswerStage(slots: StageSlots, c: CurrentQuestion) {
    slots.box.classList.add('showing-answer');
    const answerItems = c.answerContent ?? [];
    const title = answerTitle(c);
    if (title) slots.prompt.append(Object.assign(document.createElement('p'), { className: 'answer-title', textContent: title }));
    const answerTexts = answerItems.filter(isTextItem);
    answerTexts.forEach((item) => slots.prompt.append(Object.assign(document.createElement('p'), { textContent: item.value })));
    // A picture answer is marked on the question's own picture.
    if (c.answerType === 'point' || !title && !answerTexts.length) {
      c.content.filter(isTextItem).forEach((item) => slots.prompt.append(
        Object.assign(document.createElement('p'), { textContent: item.value })));
    }
    const answerMedia = answerItems.filter((item) => !isTextItem(item));
    if (c.answerType !== 'point' && answerMedia.length) {
      answerMedia.forEach((item, index) => {
        if (slotFor(item) === 'media' && answerMedia.slice(index + 1).some((later) => slotFor(later) === 'media')) return;
        placeContent(slots, item, ANSWER_INDEX + index, true);
      });
    } else {
      renderStaticContent({ ...slots, prompt: document.createElement('div') }, c.content);
    }
    const note = [c.comments, c.sources?.length ? `Sources: ${c.sources.join(', ')}` : ''].filter(Boolean).join(' ');
    if (note) slots.prompt.after(Object.assign(document.createElement('p'), { className: 'q-note', textContent: note, title: note }));
    syncStageShape(slots);
  }

  /** Pins for every picture attempt, the target ring at reveal, and the tap target for the answerer. */
  function decoratePointQuestion(slots: StageSlots, c: CurrentQuestion, pickable: boolean) {
    const frame = slots.media.querySelector<HTMLElement>('.fit');
    if (!frame) return;
    const nameOf = (id: string) => activeState().participants.find((p) => p.id === id)?.name ?? '?';
    const pins: Pin[] = c.picks.flatMap((pick) => {
      const point = parsePoint(pick.value);
      return point ? [{ ...point, label: nameOf(pick.playerId).slice(0, 1).toUpperCase(), tone: pick.correct ? 'go' : 'stop' } as Pin] : [];
    });
    const target = parsePoint(c.right?.[0]);
    // The host sees a faint ring early, to know where to look while players search.
    if (target && c.answerDeviation) drawRing(frame, target, c.answerDeviation, !c.answerShown);
    if (pickable) {
      if (pendingPick?.presentationId === c.presentationId) pins.push({ x: pendingPick.x, y: pendingPick.y, label: '', tone: 'pending' });
      makePickable(frame, (point) => {
        pendingPick = { presentationId: c.presentationId, ...point };
        renderedQuestionKey = null;
        renderQuestion();
      });
    }
    drawPins(frame, pins);
  }

  function renderQuestion() {
    const state = activeState();
    const { game, you } = state;
    const c = game.current;
    const box = $('#question');
    box.classList.toggle('hidden', !c || isIntro(game));
    if (c && isIntro(game)) return; // The card appears when reading starts, after the chosen-cell flash.

    // Update glowing border frame around question card to match stage
    box.classList.remove('frame-reading', 'frame-open', 'frame-answering');
    if (game.phase === 'reading') box.classList.add('frame-reading');
    else if (game.phase === 'buzzerOpen') box.classList.add('frame-open');
    else if (game.phase === 'answering') box.classList.add('frame-answering');

    if (!c) {
      questionPresenter?.dispose();
      questionPresenter = null;
      presenterId = null;
      presenterFinishedId = null;
      renderedQuestionKey = null;
      stageSlots = null;
      decorateStage = null;
      // A hidden card keeps playing its clips, so Next must stop and drop them on every device.
      box.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => {
        media.pause();
        media.removeAttribute('src');
        media.load();
      });
      box.replaceChildren();
      delete box.dataset.questionId;
      return;
    }
    // Avoid restarting media on every state update.
    const hiddenPhases = ['intro', 'specialSetup', 'stakeAuction', 'finalWager'];
    const contentVisible = !hiddenPhases.includes(game.phase) &&
      !(game.phase === 'paused' && hiddenPhases.includes(game.pausedPhase ?? ''));
    const presenting = contentVisible && !c.answerShown &&
      (game.phase === 'reading' || (game.phase === 'paused' && game.pausedPhase === 'reading'));
    const typed = game.buzzer.typedAnswer;
    // Only the answerer, while their answer clock runs, may tap the picture or an option.
    const canTap = game.phase === 'answering' && game.buzzer.winnerId === you.id && !!typed &&
      !typed.submitted && !typed.closed && c.answerType !== 'text';
    // Stake bids and gift setup can change the heading without changing the question index.
    const key = [c.presentationId, contentVisible, presenting, c.price, c.assignedId, c.answerShown,
      canTap, c.picks.length].join(':');
    if (key === renderedQuestionKey) {
      acknowledgePresentedContent();
      return;
    }
    renderedQuestionKey = key;

    const questionId = c.presentationId;
    previousContentMedia = new Map(box.dataset.questionId === questionId
      ? [...box.querySelectorAll<HTMLElement>('[data-content-index]')].flatMap((item) => {
        const media = item.querySelector<HTMLMediaElement>('audio, video');
        return media ? [[Number(item.dataset.contentIndex),
          { paused: media.paused, currentTime: media.currentTime }] as const] : [];
      }) : []);
    if (pendingPick && pendingPick.presentationId !== questionId) pendingPick = null;
    box.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => media.pause());
    box.replaceChildren();
    box.className = box.className.replace(/\b(has-media|has-prompt|showing-answer)\b/g, '').trim();
    box.dataset.questionId = questionId;
    box.dataset.answerType = c.answerType;

    const recipient = state.participants.find((p) => p.id === c.assignedId)?.name ?? 'Player';
    const heading = Object.assign(document.createElement('h3'), { className: 'q-meta', textContent: c.type === 'secretNoQuestion'
      ? game.phase === 'specialSetup' ? 'Gift: the host is choosing who gets it'
        : `Gift: ${recipient} receives ${formatScore(c.price)}`
      : game.round?.type === 'final' ? `Final · ${c.themeName}`
        : `${c.themeName} · ${formatScore(c.price)}` });
    const typeLabel = c.type === 'secretNoQuestion' || game.round?.type === 'final' ? '' : questionTypeLabel(c.type);
    if (typeLabel) heading.append(Object.assign(document.createElement('span'), { className: 'q-type', textContent: typeLabel }));
    box.append(heading);
    const slots = buildStage(box);
    stageSlots = slots;
    decorateStage = contentVisible && c.answerType === 'point' ? () => decoratePointQuestion(slots, c, canTap) : null;

    if (presenting) {
      if (presenterId !== c.presentationId || !questionPresenter) {
        questionPresenter?.dispose();
        presenterId = c.presentationId;
        presenterFinishedId = null;
        questionPresenter = new ContentPresenter(c.content, renderOrderedContent, () => {
          presenterFinishedId = c.presentationId;
          acknowledgePresentedContent();
        }, state.settings.timeForMediaDelay * 1000,
        state.settings.partialText && !matchMedia('(prefers-reduced-motion: reduce)').matches
          ? state.settings.readingSpeed : 0);
        questionPresenter.setPaused(game.phase === 'paused');
        questionPresenter.start();
      } else questionPresenter?.refresh();
    } else {
      questionPresenter?.dispose();
      questionPresenter = null;
      if (c.answerShown && c.right) renderAnswerStage(slots, c);
      else if (contentVisible) renderStaticContent(slots, c.content);
    }

    decorateStage?.();
    if (contentVisible && c.answerType === 'select' && c.answerOptions.length) {
      const wrongPicks = new Set(c.picks.filter((pick) => !pick.correct).map((pick) => pick.value));
      const right = new Set((c.answerShown ? c.right ?? [] : []).map((label) => label.toUpperCase()));
      box.append(optionTiles(c.answerOptions.map((option) => ({
        ...option,
        state: right.has(option.label.toUpperCase()) ? 'right' : wrongPicks.has(option.label) ? 'wrong' : 'idle',
      })), canTap ? (label) => send('game:answer', { answer: label }) : null));
    }
    if (canTap && c.answerType === 'point') {
      const actions = Object.assign(document.createElement('div'), { className: 'q-actions' });
      const pick = pendingPick?.presentationId === questionId ? pendingPick : null;
      const submit = Object.assign(document.createElement('button'), {
        type: 'button', className: 'primary', disabled: !pick,
        textContent: pick ? 'Submit this spot' : 'Tap the picture first',
      });
      submit.onclick = async () => {
        if (pick && (await send('game:answer', { answer: `${pick.x},${pick.y}` })).ok) pendingPick = null;
      };
      actions.append(submit);
      box.append(actions);
    }
    // The host's private strip is its own row, so it never covers the picture.
    if (you.role === 'host' && c.right && !c.answerShown) {
      const strip = Object.assign(document.createElement('div'), { className: 'q-host' });
      const keyText = c.answerType === 'point' ? 'Marked on the picture' : answerTitle(c);
      strip.append(Object.assign(document.createElement('span'), { textContent: 'Only you see this' }),
        Object.assign(document.createElement('strong'), { textContent: keyText }));
      if (c.showmanComments) strip.append(Object.assign(document.createElement('em'), { textContent: c.showmanComments }));
      box.append(strip);
    }
    acknowledgePresentedContent();
  }

  let typedAnswerKey = '';
  function renderTypedAnswer() {
    const { game, you, participants, settings } = activeState();
    const answering = game.phase === 'answering' ||
      (game.phase === 'paused' && game.pausedPhase === 'answering');
    const typed = game.buzzer.typedAnswer;
    const winner = you.id === game.buzzer.winnerId;
    // Options and picture clicks are answered on the stage itself, not in a text box.
    const visible = !tvMode && !settings.oral && answering && !!typed && (winner || you.canModerate) &&
      (game.current?.answerType ?? 'text') === 'text';
    $('#typed-answer').classList.toggle('hidden', !visible);
    if (!visible || !typed) return;

    const key = `${game.current?.presentationId}:${game.buzzer.winnerId}`;
    if (key !== typedAnswerKey) {
      textarea('#typed-answer-input').value = '';
      typedAnswerKey = key;
    }
    const canSubmit = winner && game.phase === 'answering' && !typed.submitted && !typed.closed;
    $('#typed-answer-form').classList.toggle('hidden', !canSubmit);
    textarea('#typed-answer-input').disabled = !canSubmit;
    const hostText = you.canModerate && typed.submitted && typed.text !== null;
    $('#typed-answer-host').classList.toggle('hidden', !hostText);
    $('#typed-answer-host').textContent = hostText ? `Submitted answer: ${typed.text}` : '';

    const winnerName = participants.find((p) => p.id === game.buzzer.winnerId)?.name ?? 'Player';
    $('#typed-answer-status').textContent = typed.submitted
      ? you.canModerate ? `${winnerName} submitted an answer. Choose Correct or Wrong.`
        : 'Answer submitted. Waiting for the host verdict.'
      : typed.closed ? 'Answer time ended. Waiting for the host verdict.'
        : game.phase === 'paused' ? 'Answer time is paused.'
          : winner ? 'Type your answer before time runs out.'
            : `Waiting for ${winnerName} to submit an answer.`;
  }

  $('#typed-answer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = textarea('#typed-answer-input');
    const answer = field.value.trim();
    if (answer && (await send('game:answer', { answer })).ok) field.value = '';
  });

  /* ---------------- stage banner & buzzer orientiers ---------------- */

  // Tablets and phones have no Space bar to suggest.
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  type StageTone = 'reading' | 'money' | 'open' | 'answering' | 'reveal' | 'idle';
  function setStage(tone: StageTone, title: string, subtitle: string) {
    const banner = $('#stage-banner');
    banner.classList.remove('state-reading', 'state-money', 'state-open', 'state-answering', 'state-reveal', 'state-idle');
    banner.classList.add(`state-${tone}`);
    $('#stage-title').textContent = title;
    $('#stage-subtitle').textContent = subtitle;
  }

  function updateOrientiers() {
    if (!state?.you) return;
    const { game, you, participants, settings } = state;
    const now = nowServer();
    const banner = $('#stage-banner');
    const buzzerBtn = $('#buzzer');
    const nameOf = (id: string | null | undefined) => participants.find((p) => p.id === id)?.name ?? 'A player';

    // 1. Status panel: the host's "voice". It is visible from the lobby on so the layout never jumps.
    const inPlay = game.phase !== 'gameOver';
    banner.classList.toggle('hidden', !inPlay);
    if (inPlay) {
      const t = game.timer;
      const remMs = t ? Math.max(0, t.endsAt - now) : 0;
      const pct = t && t.durationMs > 0 ? Math.max(0, Math.min(100, (remMs / t.durationMs) * 100)) : 0;
      $('#stage-countdown').textContent = t ? String(Math.ceil(remMs / 1000)) : '';
      $('#stage-progress-fill').style.width = `${pct}%`;
      // The table frame is the clock: its lit edge drains as the countdown runs.
      const stage = $('#game-stage');
      stage.classList.toggle('timed', !!t && remMs > 0 && t.name !== 'intro');
      stage.style.setProperty('--left', String(pct / 100));
      const chooser = game.chooserId === you.id ? 'You' : nameOf(game.chooserId);
      const canPick = you.canModerate || game.chooserId === you.id;

      if (game.phase === 'lobby') {
        const host = participants.find((p) => p.role === 'host');
        const players = participants.filter((p) => p.role === 'player' && p.connected).length;
        setStage('idle', 'Waiting to start', you.canManage
          ? 'Load a pack and check the settings below, then press Start game.'
          : `${players} player${players === 1 ? '' : 's'} in. ${host ? `${host.name} starts the game` : 'A host starts the game'} when everyone is here.`);
      } else if (game.phase === 'intro' && game.current) {
        // The pick is announced the same way on every screen; the twist of a special question is named here.
        const c = game.current;
        const theme = game.board[c.themeIndex]?.name ?? c.themeName;
        const withPrice = `${theme} for ${formatScore(c.price)}`;
        const intro: Record<string, [string, string]> = {
          secret: [theme, 'Secret question. The host picks who answers.'],
          secretPublicPrice: [withPrice, 'Secret question. The host picks who answers.'],
          secretNoQuestion: [theme, 'Gift question.'],
          stake: [withPrice, 'Auction. Players bid for the question.'],
          noRisk: [withPrice, 'No risk. A wrong answer costs nothing.'],
          forAll: [withPrice, 'Everyone answers in private.'],
        };
        const [title, subtitle] = intro[c.type] ?? [withPrice, 'Get ready.'];
        setStage('reading', title, subtitle);
        $('#stage-countdown').textContent = '';
      } else if (game.phase === 'paused') {
        setStage('reading', 'Game paused', you.canModerate ? 'Press Resume to continue.' : 'Waiting for the host to resume.');
      } else if (game.phase === 'board') {
        setStage('idle', game.chooserId === you.id ? 'Your pick' : `${chooser} picks next`,
          canPick ? 'Choose a theme and a price on the board.' : 'Waiting for a question to be chosen.');
      } else if (game.phase === 'finalThemes') {
        setStage('idle', 'Final round', canPick ? 'Remove themes until one is left.' : `${chooser} removes a theme.`);
      } else if (game.phase === 'specialSetup') {
        setStage('reading', game.current?.type === 'secretNoQuestion' ? 'A gift question' : 'Special question',
          you.canModerate ? 'Choose who answers and the value below.' : 'The host is setting up this question.');
      } else if (game.phase === 'roundEnd') {
        setStage('idle', 'Round complete', you.canModerate ? 'Press Next to continue.' : 'The next round starts soon.');
      } else if (game.phase === 'finalWager') {
        setStage('money', 'Place your final wager', you.role === 'player'
          ? 'Your wager is private until the answers are judged.' : 'Players are placing private wagers.');
      } else if (game.phase === 'stakeAuction') {
        setStage('money', 'Question auction', 'Players bid in turn for the right to answer.');
      } else if (game.phase === 'forAllAnswering') {
        setStage('reading', 'Everyone answers', 'Submit a private answer before time runs out.');
      } else if (game.phase === 'forAllJudge') {
        setStage('answering', 'Checking answers', 'The host is judging every answer.');
      } else if (game.phase === 'appealVote') {
        setStage('answering', 'Appeal vote', 'Eligible players are reviewing the verdict.');
      } else if (game.phase === 'reading') {
        // The host reads the question; players get the rule for pressing.
        if (you.role === 'host') setStage('reading', 'Read the question', game.current?.type === 'forAll'
          ? 'Private answers open when reading ends.' : 'Open the buzzer when you finish.');
        else setStage('reading', 'Listen to the question', game.current?.type === 'forAll'
          ? 'Private answers open after reading.'
          : !settings.falseStart ? 'You can buzz while the question plays.'
            : `Wait for the green signal. An early press blocks you for ${settings.timeForBlockingButton} s.`);
      } else if (game.phase === 'buzzerOpen') {
        setStage('open', 'Buzz now', you.role === 'player' ? (touchOnly ? 'Tap the button.' : 'Tap the button or press Space.') : 'Players can press their buttons.');
      } else if (game.phase === 'answering') {
        const winnerId = game.buzzer.winnerId;
        const info = game.buzzer.winnerInfo;
        const reaction = info?.reactionMs != null ? ` Reaction ${info.reactionMs} ms.` : '';
        const title = winnerId === you.id ? 'Your answer' : `${nameOf(winnerId)} answers`;
        const tapType = game.current?.answerType ?? 'text';
        if (tapType !== 'text') {
          const how = tapType === 'point' ? 'Tap the picture where it is, then submit.' : 'Tap one of the options.';
          setStage('answering', title, winnerId === you.id ? how
            : `${tapType === 'point' ? 'Picture' : 'Option'} answer. It is checked automatically.`);
        } else if (!settings.oral) {
          const typed = game.buzzer.typedAnswer;
          setStage('answering', title, typed?.submitted
            ? you.canModerate ? 'Answer submitted. Choose Correct or Wrong.' : 'Answer submitted. Waiting for the verdict.'
            : typed?.closed ? 'Time is up. Waiting for the verdict.'
              : winnerId === you.id ? 'Type your answer before time runs out.' : 'Waiting for a written answer.');
        } else if (!t || remMs <= 0) {
          // The host still judges after the answer clock ends; make that handoff explicit.
          $('#stage-countdown').textContent = '0';
          setStage('answering', title, you.canModerate ? 'Time is up. Choose Correct or Wrong.' : 'Time is up. Waiting for the verdict.');
        } else {
          setStage('answering', title, (you.canModerate ? 'Listen, then choose Correct or Wrong.'
            : winnerId === you.id ? 'Say your answer out loud.' : 'Listen to the answer.') + reaction);
        }
      } else if (game.phase === 'finalQuestion') {
        setStage('reading', 'Final question', 'Prepare your answer before time runs out.');
      } else if (game.phase === 'finalJudge') {
        setStage('answering', 'Final judging', 'The host is checking every answer.');
      } else if (game.phase === 'reveal') {
        if (game.current?.answerShown) {
          // The answer itself is on the table; saying it here too would print it twice.
          setStage('reveal', 'Answer shown',
            t ? 'Back to the board in a moment.' : you.canModerate ? 'Press Next to continue.' : 'Waiting for the host.');
          if (!t) $('#stage-progress-fill').style.width = '100%';
        } else {
          setStage('idle', 'No one got it', you.canModerate
            ? 'Show the answer, or press Next to return to the board.' : 'Waiting for the host.');
          $('#stage-countdown').textContent = '';
          $('#stage-progress-fill').style.width = '0%';
        }
      } else {
        setStage('idle', game.round?.name ?? 'Game in progress', '');
      }
    }

    // 2. Player Buzzer Button Orientier
    // Keep the fixed buzzer off finished phases so it cannot cover mobile appeal controls.
    const showBuzzer = you.role === 'player' && ['intro', 'reading', 'buzzerOpen', 'answering'].includes(game.phase) &&
      (settings.oral || game.phase !== 'answering') &&
      game.current?.type !== 'forAll' && game.round?.type !== 'final';
    buzzerBtn.classList.toggle('hidden', !showBuzzer);
    buzzerBtn.classList.toggle('moderator-buzzer', !!you?.canModerate);
    if (!showBuzzer) return;

    buzzerBtn.classList.remove('buzz-reading', 'buzz-open', 'buzz-blocked', 'buzz-you-answering', 'buzz-idle');
    const blockedUntil = game.buzzer?.blockedUntil ?? 0;
    const isBlocked = blockedUntil > now;
    const alreadyTried = (game.buzzer?.attempted ?? []).includes(you.id);
    const setBuzzer = (tone: string, main: string, sub: string) => {
      buzzerBtn.classList.add(tone);
      $('#buzzer-main').textContent = main;
      $('#buzzer-sub').textContent = sub;
    };

    if (isBlocked) {
      setBuzzer('buzz-blocked', `Blocked ${((blockedUntil - now) / 1000).toFixed(1)} s`, 'You pressed before the signal.');
    } else if (alreadyTried && (game.phase === 'buzzerOpen' || game.phase === 'answering')) {
      setBuzzer('buzz-idle', 'You already answered', 'Waiting for the others.');
    } else if (game.phase === 'intro') {
      // Nothing can be pressed until the question appears, whatever the false-start rule says.
      setBuzzer('buzz-reading', 'Wait', settings.falseStart
        ? `An early press blocks you for ${settings.timeForBlockingButton} s.` : 'Opens after the question.');
    } else if (game.phase === 'reading') {
      if (settings.falseStart) setBuzzer('buzz-reading', 'Wait for green', `An early press blocks you for ${settings.timeForBlockingButton} s.`);
      else setBuzzer('buzz-open', 'Buzz', 'Press now to answer.');
    } else if (game.phase === 'buzzerOpen') {
      setBuzzer('buzz-open', 'Buzz', touchOnly ? 'Tap here.' : 'Tap here or press Space.');
    } else if (game.phase === 'answering') {
      if (game.buzzer.winnerId === you.id) setBuzzer('buzz-you-answering', 'Your answer',
        (game.current?.answerType ?? 'text') === 'text' ? 'Say it out loud to the host.' : 'Tap your answer on the stage.');
      else setBuzzer('buzz-idle', `${nameOf(game.buzzer.winnerId)} answers`, 'Get ready in case they are wrong.');
    } else {
      setBuzzer('buzz-idle', 'Waiting for a question', 'The button opens after a question is chosen.');
    }
    // "Wait" stays on screen from the pick until the buttons open, so the thumb has a home and nothing jumps.
    // Other idle states (already answered, someone else answering) only cover the podiums, so they hide.
    buzzerBtn.classList.toggle('hidden', buzzerBtn.classList.contains('buzz-idle'));
  }

  /* ---------------- fast tick for smooth countdown bars ---------------- */

  setInterval(() => {
    if (!state?.game) return;
    updateOrientiers();
  }, 100);

  /*
   * While a question is read, its words light up in step with the reading clock (the same clock
   * the table frame drains), so players see how far the host has got. A short fading edge runs
   * ahead of the lit text every frame, so the sweep glides instead of stepping a letter at a time.
   */
  const READ_EDGE = 8;
  function paintReadingProgress() {
    const s = state;
    if (!s?.game.current || !stageSlots || s.settings.partialText) return;
    if (s.game.phase === 'paused') return; // Keep the highlight where the pause froze it.
    const t = s.game.timer;
    const reading = s.game.phase === 'reading' && t?.name === 'reading' && t.durationMs > 0;
    const lines = [...stageSlots.prompt.querySelectorAll<HTMLElement>('.slot-item > p')];
    const fullText = (p: HTMLElement) => (p.dataset.full ??= p.textContent ?? '');
    const total = lines.reduce((sum, p) => sum + fullText(p).length, 0);
    const done = reading && t ? Math.min(1, Math.max(0, 1 - (t.endsAt - nowServer()) / t.durationMs)) : 1;
    // Stretch the sweep so the fading edge also finishes exactly when the clock does.
    const progress = done * (total + READ_EDGE);
    let offset = 0;
    for (const p of lines) {
      const full = fullText(p);
      const local = progress - offset;
      offset += full.length;
      const finished = !reading || local >= full.length + READ_EDGE;
      const key = finished ? 'full' : (Math.round(local * 8) / 8).toFixed(3);
      if (p.dataset.lit === key) continue;
      p.dataset.lit = key;
      if (finished) {
        p.textContent = full;
        continue;
      }
      const lit = Math.max(0, Math.floor(local - READ_EDGE));
      const parts: (string | HTMLElement)[] = [full.slice(0, lit)];
      const edgeEnd = Math.min(full.length, Math.max(0, Math.ceil(local)));
      for (let i = lit; i < edgeEnd; i++) {
        // 1 at the lit side, falling to 0 at the reading point.
        const k = Math.min(1, Math.max(0, (local - i) / READ_EDGE));
        const char = Object.assign(document.createElement('span'), { textContent: full[i] });
        char.style.color = `color-mix(in srgb, var(--paper) ${Math.round(36 + 64 * k)}%, transparent)`;
        parts.push(char);
      }
      parts.push(Object.assign(document.createElement('span'), { className: 'unread', textContent: full.slice(edgeEnd) }));
      p.replaceChildren(...parts);
    }
  }
  const readingFrame = () => {
    paintReadingProgress();
    requestAnimationFrame(readingFrame);
  };
  requestAnimationFrame(readingFrame);


  /* ---------------- controls ---------------- */

  function triggerBuzz() {
    socket.emit('game:buzz', { clientAt: Math.round(nowServer()) }, () => {});
  }
  $('#buzzer').addEventListener('pointerdown', triggerBuzz);
  // Keyboard and assistive clicks have no pointerdown; pointer clicks already buzz above.
  $('#buzzer').addEventListener('click', (event) => {
    if (event.detail === 0) triggerBuzz();
  });
  document.addEventListener('keydown', (e) => {
    const focused = document.activeElement;
    // Focused buttons use their native keyboard click, avoiding a second buzz.
    const otherControl = focused instanceof HTMLElement &&
      (focused.isContentEditable || !!focused.closest('input, textarea, select, button, a, [role="button"]'));
    if (e.code === 'Space' && state?.you?.role === 'player' && state.game.current?.type !== 'forAll' && !otherControl) {
      e.preventDefault();
      if (!e.repeat) triggerBuzz();
    }
  });

  /*
   * Host shortcuts: Space runs the highlighted step (Skip during the intro), Y and N give a verdict.
   * Keys use e.code so a Russian layout works. A step that just changed ignores keys for 700 ms, so a
   * double press cannot skip the intro and then open the buttons before anyone has read the question.
   */
  const HOST_KEYS_KEY = 'sigame.hostKeys';
  let hostKeys = true;
  try { hostKeys = localStorage.getItem(HOST_KEYS_KEY) !== 'off'; } catch { /* Keep the default. */ }
  input('#pref-hostKeys').checked = hostKeys;
  input('#pref-hostKeys').addEventListener('change', () => {
    hostKeys = input('#pref-hostKeys').checked;
    try { localStorage.setItem(HOST_KEYS_KEY, hostKeys ? 'on' : 'off'); } catch { /* Not saved. */ }
  });
  document.addEventListener('keydown', (e) => {
    if (!hostKeys || tvMode || settingsOpen || state?.you?.role !== 'host') return;
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || Date.now() - stepChangedAt < 700) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement &&
      (focused.isContentEditable || focused.closest('input, textarea, select, button, a, [role="button"], #manage'))) return;
    const bar = $('#host-controls');
    const usable = (el: HTMLButtonElement | null) => el && !el.disabled && !el.classList.contains('hidden') ? el : null;
    const target = e.code === 'Space'
      ? usable(bar.querySelector<HTMLButtonElement>(state.game.phase === 'intro' ? '[data-act="game:next"]' : ':scope > button.primary'))
      : e.code === 'KeyY' ? usable(bar.querySelector<HTMLButtonElement>('[data-act="judge-ok"]'))
        : e.code === 'KeyN' ? usable(bar.querySelector<HTMLButtonElement>('[data-act="judge-bad"]')) : null;
    if (!target || bar.classList.contains('hidden')) return;
    e.preventDefault();
    target.click();
  });

  for (const b of document.querySelectorAll<HTMLElement>('[data-act]')) {
    b.addEventListener('click', (event) => {
      const act = b.dataset.act;
      if (!act) return;
      // A mouse click leaves focus on the button, and Space would then press it again natively.
      if (event.detail > 0 && b.closest('#host-controls')) b.blur();
      if (act === 'game:stop' && !confirm('Stop this game? Scores and progress will be reset.')) return;
      if (act === 'game:next' && state?.game?.phase === 'specialSetup' &&
          !confirm('Skip this special question?')) return;
      if (act === 'judge-ok') send('game:judge', { correct: true });
      else if (act === 'judge-half') send('game:judge', { correct: true, factor: 0.5 });
      else if (act === 'judge-double') send('game:judge', { correct: true, factor: 2 });
      else if (act === 'judge-bad') send('game:judge', { correct: false });
      else if (isNoPayloadCommand(act)) send(act);
    });
  }

  $('#btn-start').addEventListener('click', () => send('game:start'));

  $('#steam-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#steam-log').textContent = '';
    send('steam:download', { link: input('#steam-link').value });
  });
  socket.on('steam:progress', (p) => {
    const log = $('#steam-log');
    log.textContent += `[${p.stage}] ${p.message}${p.percent != null ? ` (${p.percent}%)` : ''}\n`;
    log.scrollTop = log.scrollHeight;
  });
  socket.on('packs:changed', () => refreshPacks());
})();

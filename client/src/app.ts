import { io, type Socket } from 'socket.io-client';
import { ContentPresenter } from './contentPresenter';
import type { Ack, ClientToServerEvents, CommandEvent, CommandPayloads, ContentItem,
  JoinAck, NoPayloadCommand, RoomState, ServerToClientEvents } from './types';

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
    'game:next', 'game:nextRound', 'game:stop', 'game:closeForAll', 'game:appealClose',
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
          alert(result.error ?? 'Request failed');
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
    alert('You were removed by the host');
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

  socket.on('room:state', (s: RoomState) => {
    state = s;
    if (!Number.isFinite(bestRtt)) clockOffset = s.serverTime - Date.now();
    render();
  });

  socket.on('game:event', (evt) => {
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

  function render() {
    if (!state) return;
    const { you, game } = state;
    if (!you) return show('screen-join');
    if (you.role === 'pending') return show('screen-role');
    show('screen-game');
    $('#screen-game').dataset.phase = game.phase;
    if (tvMode) {
      $('#me').textContent = 'TV view';
      $('#phase').textContent = game.round ? game.round.name : game.phase.replace(/([A-Z])/g, ' $1');
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

    $('#me').textContent = `${you.name} · ${you.role}${you.isOwner ? ' · owner' : ''}`;
    $('#phase').textContent = game.phase === 'gameOver'
      ? 'Game over'
      : game.round ? `${game.round.name} · ${game.phase.replace(/([A-Z])/g, ' $1')}`
        : game.phase.replace(/([A-Z])/g, ' $1');

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

  function renderHostControls() {
    const state = activeState();
    const { you, game } = state;
    const mod = you.canModerate && game.phase !== 'lobby';
    $('#host-controls').classList.toggle('hidden', !mod);
    if (!mod) return;
    button('#btn-undo-judgment').classList.toggle('hidden', !game.undoJudgment);
    for (const button of $('#host-controls').querySelectorAll('button')) {
      const action = button.dataset.act;
      if (action === 'game:pause') {
        button.classList.toggle('hidden', game.phase === 'paused');
        button.disabled = game.phase === 'gameOver';
      }
      if (action === 'game:resume') button.classList.toggle('hidden', game.phase !== 'paused');
      if (action === 'judge-ok' || action === 'judge-bad') button.disabled = game.phase !== 'answering' ||
        (!state.settings.oral && !game.buzzer.typedAnswer?.submitted && !game.buzzer.typedAnswer?.closed);
      if (action === 'game:reveal') button.disabled = game.current?.type === 'forAll' ||
        !['reading', 'buzzerOpen', 'answering'].includes(game.phase);
      if (action === 'game:next') button.disabled = !['reveal', 'roundEnd', 'specialSetup', 'stakeAuction'].includes(game.phase);
      if (action === 'game:next') {
        const finalReveal = game.phase === 'reveal' && game.round?.type === 'final';
        const moreFinalThemes = game.board.some((theme) => theme.questions[0]?.available);
        button.textContent = finalReveal && state.settings.playAllQuestionsInFinalRound
          ? moreFinalThemes ? 'Next final theme ▶' : 'Finish game ▶' : 'Next ▶';
      }
      if (action === 'game:nextRound') button.disabled = game.phase !== 'roundEnd';
    }

    const openBtn = button('#btn-open-buzzer');
    openBtn.classList.toggle('hidden', game.current?.type === 'forAll');
    openBtn.disabled = game.phase !== 'reading' || game.current?.type === 'forAll';
    openBtn.textContent = game.phase === 'reading'
      ? '🔓 Open buzzer now' : '🟢 Buzzer open';
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
    const wagering = game.phase === 'finalWager';
    const player = you.role === 'player';
    $('#final-wager').classList.toggle('hidden', !wagering || !player || !final);
    $('#final-host').classList.toggle('hidden', !final);
    if (!final) return;
    if (wagering && player) {
      const me = participants.find((p) => p.id === you.id);
      input('#final-amount').max = String(Math.max(0, me?.score ?? 0));
      $('#final-wager-status').textContent = final.wagered.includes(you.id)
        ? `Saved: ${final.yourWager}` : '';
    }
    const host = you.canModerate && ['finalWager', 'finalQuestion', 'finalJudge'].includes(game.phase);
    $('#final-host').classList.toggle('hidden', !host);
    if (!host) return;
    button('#btn-open-final').disabled = !wagering || participants.some((p) => p.role === 'player' && p.connected && !final.wagered.includes(p.id));
    button('#btn-close-final').disabled = game.phase !== 'finalQuestion';
    const playerSelect = select('#final-player');
    playerSelect.replaceChildren();
    for (const p of participants.filter((p) => p.role === 'player' && !final.judged.includes(p.id))) {
      playerSelect.add(new Option(`${p.name}${final.wagers ? ` · ${final.wagers[p.id]}` : ''}`, p.id));
    }
    button('#btn-final-correct').disabled = game.phase !== 'finalJudge' || !playerSelect.value;
    button('#btn-final-wrong').disabled = game.phase !== 'finalJudge' || !playerSelect.value;
  }

  $('#final-wager').addEventListener('submit', (event) => {
    event.preventDefault();
    send('game:finalWager', { amount: Number(input('#final-amount').value) });
  });
  $('#btn-open-final').onclick = () => send('game:openFinal');
  $('#btn-close-final').onclick = () => send('game:closeFinal');
  button('#btn-final-correct').onclick = () => send('game:judgeFinal', { playerId: select('#final-player').value, correct: true });
  button('#btn-final-wrong').onclick = () => send('game:judgeFinal', { playerId: select('#final-player').value, correct: false });

  function renderSpecialSetup() {
    const state = activeState();
    const visible = state.you.canModerate && state.game.phase === 'specialSetup';
    $('#special-setup').classList.toggle('hidden', !visible);
    const current = state.game.current;
    if (!visible || !current) return;
    const gift = current.type === 'secretNoQuestion';
    $('#special-setup strong').textContent = gift ? 'Gift: choose who receives the points' : 'Special question setup';
    $('#special-setup button[type="submit"]').textContent = gift ? 'Award points' : 'Show question';
    const playerSelect = select('#special-player');
    const previous = playerSelect.value;
    playerSelect.replaceChildren();
    for (const player of state.participants.filter((p) => p.role === 'player' && p.connected)) {
      playerSelect.add(new Option(player.name, player.id));
    }
    if (state.participants.some((p) => p.id === previous && p.connected)) playerSelect.value = previous;
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
      ? `Tie: ${winners.map((p) => p.name).join(', ')} · ${winners[0].score} pts`
      : winners.length ? `Winner: ${winners[0].name} · ${winners[0].score} pts` : 'No player scores.';
    const list = $('#results-list');
    list.replaceChildren();
    for (const player of ranking) {
      const item = document.createElement('li');
      item.textContent = `${player.name} — ${player.score} pts`;
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

    $('#players').innerHTML = '';
    for (const p of participants) {
      // TV connections are display devices, not contestants on the scoreboard.
      if (p.displayOnly && game.phase !== 'lobby') continue;
      const el = document.createElement('div');
      el.className = 'player';
      el.classList.add(`role-${p.role}`);
      if (!p.connected) el.classList.add('off');
      if (p.id === game.chooserId && game.phase === 'board') el.classList.add('chooser');

      const isAnswering = p.id === game.buzzer.winnerId && game.phase === 'answering';
      const blockedUntil = blockedMap.get(p.id) ?? 0;
      const isBlocked = blockedUntil > now;
      const hasTried = attemptedSet.has(p.id);

      if (isAnswering) el.classList.add('answering');
      else if (isBlocked) el.classList.add('blocked');

      const name = document.createElement('b');
      name.textContent = p.name;
      const score = document.createElement('small');
      score.textContent = p.role === 'player' ? `${p.score} pts` : p.role;
      const slot = document.createElement('div');
      slot.className = 'badge-slot';
      el.append(name, score, slot);
      if (isAnswering) {
        slot.innerHTML = `<span class="badge answering-badge">${state.settings.oral ? '🎤 Answering' : '✍️ Writing'}</span>`;
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
        plus.onclick = () => send('score:adjust', { targetId: p.id, delta: 100 });
        minus.onclick = () => send('score:adjust', { targetId: p.id, delta: -100 });
        plus.setAttribute('aria-label', `Add 100 points to ${p.name}`);
        minus.setAttribute('aria-label', `Subtract 100 points from ${p.name}`);
        const custom = Object.assign(document.createElement('button'), { textContent: 'Adjust…' });
        custom.setAttribute('aria-label', `Adjust ${p.name}'s score by a custom amount`);
        custom.onclick = () => {
          const raw = prompt(`Score change for ${p.name} (for example, -250 or 350):`);
          if (raw === null) return;
          const delta = Number(raw.trim());
          if (!raw.trim() || !Number.isSafeInteger(delta)) {
            alert('Enter a whole-number score change.');
            return;
          }
          send('score:adjust', { targetId: p.id, delta });
        };
        row.append(plus, minus, custom);
        el.append(row);
      }
      if (you.canModerate && p.id !== you.id) {
        const kick = Object.assign(document.createElement('button'), { textContent: 'Remove' });
        kick.className = 'bad';
        kick.setAttribute('aria-label', `Remove ${p.name} from the room`);
        kick.onclick = () => {
          if (confirm(`Remove ${p.name} from the room?`)) send('participant:kick', { targetId: p.id });
        };
        el.append(kick);
      }
      const vacantHostSeat = !participants.some((member) => member.role === 'host');
      const canAppoint = state.game.phase === 'lobby'
        ? p.role === 'player' || p.role === 'spectator'
        : p.role === 'spectator';
      if (you.canModerate && vacantHostSeat && p.connected && !p.displayOnly && p.id !== you.id && canAppoint) {
        const appoint = Object.assign(document.createElement('button'), { textContent: 'Make host' });
        appoint.setAttribute('aria-label', `Make ${p.name} host`);
        appoint.onclick = () => send('role:set', { targetId: p.id, role: 'host' });
        el.append(appoint);
      }
      if (you.canModerate && p.role === 'host' && !p.connected) {
        const release = Object.assign(document.createElement('button'), { textContent: 'Release host seat' });
        release.setAttribute('aria-label', `Release ${p.name} from the host seat`);
        release.onclick = () => send('role:set', { targetId: p.id, role: 'spectator' });
        el.append(release);
      }
      $('#players').append(el);
    }
  }

  /* ---------------- lobby settings & packs ---------------- */

  const numberSettingKeys = [
    'maxPlayers', 'timeForBlockingButton', 'buzzSyncWindowMs', 'readingSpeed', 'timeForThinkingOnQuestion',
    'timeForPrintingAnswer', 'timeForMakingStake', 'timeForThinkingOnSpecial',
    'timeForFinalThinking', 'timeOfRound',
  ] as const;
  let packsLoaded = false;
  async function refreshPacks() {
    const res = await send('packs:list');
    if (!res.ok) return;
    $('#pack-list').innerHTML = '';
    for (const p of res.packs ?? []) {
      const li = document.createElement('li');
      const btn = Object.assign(document.createElement('button'), { textContent: 'Load' });
      btn.disabled = !!p.error;
      btn.setAttribute('aria-label', p.error ? `${p.name} unavailable: ${p.error}` : `Load ${p.name}`);
      btn.onclick = () => send('packs:load', { file: p.file });
      li.append(btn, ` ${p.name} (${p.rounds ?? '?'} rounds, ${(p.size / 1e6).toFixed(1)} MB)`);
      if (p.error) li.append(Object.assign(document.createElement('span'), {
        className: 'error', textContent: ` — ${p.error}`,
      }));
      $('#pack-list').append(li);
    }
  }
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

  function renderManage() {
    const state = activeState();
    const showManage = state.you.canManage && state.game.phase === 'lobby';
    $('#manage').classList.toggle('hidden', !showManage);
    if (!showManage) return;

    if (!packsLoaded) {
      packsLoaded = true;
      refreshPacks();
    }
    $('#pack-current').textContent = state.pack
      ? `✅ Loaded: ${state.pack.name} — ${state.pack.stats.questions} questions (${state.pack.rounds.length} rounds)`
      : '⚠️ No pack loaded yet — choose or download one below';
    const ready = state.pack && state.participants.some((p) => p.role === 'host' && p.connected) &&
      state.participants.some((p) => p.role === 'player' && p.connected);
    button('#btn-start').disabled = !ready;
    $('#start-hint').textContent = ready ? '' : 'Load a pack, connect a player, and appoint a connected host.';

    // Sync settings inputs
    const s = state.settings;
    if (document.activeElement !== select('#set-gameMode')) select('#set-gameMode').value = s.gameMode;
    if (document.activeElement !== input('#set-falseStart')) input('#set-falseStart').checked = s.falseStart;
    $('#set-falseStart-desc').textContent = s.falseStart
      ? `On: Early presses block the buzzer for ${s.timeForBlockingButton}s.`
      : 'Off: Players can buzz while the question is shown.';

    if (document.activeElement !== select('#set-buzzSyncMode')) {
      select('#set-buzzSyncMode').value = s.buzzSyncMode;
    }
    $('#set-buzzSyncMode-desc').textContent = s.buzzSyncMode === 'clientTimestamp'
      ? `Collect presses for ${s.buzzSyncWindowMs}ms and compare calibrated device times.`
      : 'The first press received by the server wins.';

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

  function renderBoard() {
    const state = activeState();
    const { game, you } = state;
    const board = $('#board');
    board.innerHTML = '';
    if (game.phase === 'finalThemes') {
      board.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))';
      const canRemove = you.canModerate || you.id === game.chooserId;
      game.board.forEach((theme, index) => {
        if (game.removedFinalThemes.includes(index) || !theme.questions[0]?.available) return;
        const el = document.createElement(canRemove ? 'button' : 'div');
        el.className = 'theme';
        el.textContent = `${theme.name}${canRemove ? ' · Remove' : ''}`;
        if (canRemove) {
          el.setAttribute('type', 'button');
          el.onclick = () => send('game:removeFinalTheme', { themeIndex: index });
        }
        board.append(el);
      });
      return;
    }
    if (game.phase !== 'board') return;
    const cols = Math.max(...game.board.map((t) => t.questions.length), 1);
    board.style.gridTemplateColumns = `minmax(120px, 2fr) repeat(${cols}, 1fr)`;
    const canPick = you.canModerate || you.id === game.chooserId;
    game.board.forEach((theme, t) => {
      board.append(Object.assign(document.createElement('div'), { className: 'theme', textContent: theme.name }));
      for (let q = 0; q < cols; q++) {
        const cell = theme.questions[q];
        const el = document.createElement(cell?.available && canPick ? 'button' : 'div');
        el.className = 'cell' + (cell?.available ? '' : ' used');
        el.textContent = String(cell?.price ?? '');
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
    el.controls = true;
    el.preload = 'auto';
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
    if (it.type === 'image' && it.url) return Object.assign(document.createElement('img'), { src: it.url });
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

  function contentHtml(items: ContentItem[] | null,
    previousMedia: { paused: boolean; currentTime: number }[] = [], autoStart = true) {
    const div = document.createElement('div');
    for (const it of items ?? []) {
      const previous = it.type === 'audio' || it.type === 'video' ? previousMedia.shift() : undefined;
      div.append(contentElement(it, previous, autoStart));
    }
    return div;
  }

  let renderedQuestionKey: string | null = null;
  let questionPresenter: ContentPresenter<ContentItem> | null = null;
  let presenterId: string | null = null;
  let presenterFinishedId: string | null = null;
  let presenterAckingId: string | null = null;
  let questionContentRoot: HTMLElement | null = null;
  let previousContentMedia = new Map<number, { paused: boolean; currentTime: number }>();

  function acknowledgePresentedContent() {
    if (!state?.you?.canModerate || state.game.phase !== 'reading' || !socket.connected) return;
    const current = state.game.current;
    if (!current || presenterFinishedId !== current.presentationId ||
        presenterAckingId === current.presentationId ||
        !current.content.some((item) =>
          (item.type === 'audio' || item.type === 'video') && item.waitForFinish)) return;
    presenterAckingId = current.presentationId;
    socket.emit('game:contentFinished', { presentationId: current.presentationId }, () => {
      presenterAckingId = null;
    });
  }

  function renderOrderedContent(item: ContentItem, index: number, active: boolean,
    _replay: boolean, done: () => void) {
    if (!questionContentRoot) return;
    const placement = item.placement ?? (item.type === 'audio' ? 'background' : 'screen');
    const slot = questionContentRoot.querySelector<HTMLElement>(`.content-${placement}`);
    if (!slot) return;
    if (placement === 'screen') {
      slot.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => media.pause());
      slot.replaceChildren();
    }
    const wrapper = document.createElement('div');
    wrapper.dataset.contentIndex = String(index);
    const previous = previousContentMedia.get(index);
    previousContentMedia.delete(index);
    // A non-blocking background track may still be playing when its ticket rotates.
    const resumeBackground = placement === 'background' && previous?.paused === false;
    const element = contentElement(item, previous, active || resumeBackground);
    wrapper.append(element);
    slot.append(wrapper);
    if (active && (item.type === 'text' || item.type === 'say') && !item.missing) {
      // The presenter controls timing; updating one text node avoids restarting this item.
      return (visibleText: string) => { element.textContent = visibleText; };
    }
    if (active && (item.type === 'audio' || item.type === 'video') && item.waitForFinish) {
      const media = wrapper.querySelector<HTMLMediaElement>('audio, video');
      if (media) {
        media.addEventListener('ended', done, { once: true });
        media.addEventListener('error', done, { once: true });
      } else queueMicrotask(done); // A missing pack asset must not trap the game in reading.
    }
  }

  function renderQuestion() {
    const state = activeState();
    const { game } = state;
    const c = game.current;
    const box = $('#question');
    const hostAnswer = $('#host-answer');
    const preview = state.you.role === 'host' && !c?.answerShown ? c?.right : null;
    hostAnswer.classList.toggle('hidden', !preview);
    if (preview) hostAnswer.textContent = `Host answer: ${preview.join(' / ')}`;
    box.classList.toggle('hidden', !c);

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
      delete box.dataset.questionId;
      return;
    }
    // Avoid restarting media on every state update.
    const hiddenPhases = ['specialSetup', 'stakeAuction', 'finalWager'];
    const contentVisible = !hiddenPhases.includes(game.phase) &&
      !(game.phase === 'paused' && hiddenPhases.includes(game.pausedPhase ?? ''));
    const presenting = contentVisible && !c.answerShown &&
      (game.phase === 'reading' || (game.phase === 'paused' && game.pausedPhase === 'reading'));
    // Stake bids and gift setup can change the heading without changing the question index.
    const key = `${c.presentationId}:${contentVisible}:${presenting}:${c.price}:${c.assignedId}:${c.answerShown}`;
    if (key === renderedQuestionKey) {
      acknowledgePresentedContent();
      return;
    }
    renderedQuestionKey = key;

    const questionId = c.presentationId;
    const previousMedia = box.dataset.questionId === questionId
      ? [...box.querySelectorAll<HTMLMediaElement>('audio, video')].map((item) =>
        ({ paused: item.paused, currentTime: item.currentTime })) : [];
    previousContentMedia = new Map(box.dataset.questionId === questionId
      ? [...box.querySelectorAll<HTMLElement>('[data-content-index]')].flatMap((item) => {
        const media = item.querySelector<HTMLMediaElement>('audio, video');
        return media ? [[Number(item.dataset.contentIndex),
          { paused: media.paused, currentTime: media.currentTime }] as const] : [];
      }) : []);
    box.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => media.pause());
    box.innerHTML = '';
    box.dataset.questionId = questionId;
    const recipient = state.participants.find((p) => p.id === c.assignedId)?.name ?? 'Player';
    box.append(Object.assign(document.createElement('h3'), { textContent: c.type === 'secretNoQuestion'
      ? game.phase === 'specialSetup' ? '🎁 Gift · Host is choosing a recipient'
        : `🎁 ${recipient} receives ${c.price} points`
      : game.round?.type === 'final' ? `Final · ${c.themeName}`
        : `${c.themeName} · ${c.price}${c.type !== 'simple' ? ` · ${c.type}` : ''}` }));
    if (presenting) {
      questionContentRoot = document.createElement('div');
      questionContentRoot.className = 'question-content';
      for (const placement of ['screen', 'replic', 'background']) {
        questionContentRoot.append(Object.assign(document.createElement('div'), {
          className: `content-${placement}`,
        }));
      }
      box.append(questionContentRoot);
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
      questionContentRoot = null;
      if (contentVisible) box.append(contentHtml(c.content, previousMedia, false));
    }
    if (c.right && c.answerShown) {
      const ans = document.createElement('div');
      ans.className = 'answer';
      ans.append(Object.assign(document.createElement('b'), { textContent: `Answer: ${c.right.join(' / ')}` }));
      if (c.answerContent?.length) ans.append(contentHtml(c.answerContent, previousMedia));
      if (c.comments) ans.append(Object.assign(document.createElement('p'), { textContent: c.comments }));
      if (c.sources?.length) ans.append(Object.assign(document.createElement('p'), {
        textContent: `Sources: ${c.sources.join(' · ')}`,
      }));
      box.append(ans);
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
    const visible = !tvMode && !settings.oral && answering && !!typed && (winner || you.canModerate);
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

  function updateOrientiers() {
    if (!state?.you) return;
    const { game, you, participants, settings } = state;
    const now = nowServer();
    const banner = $('#stage-banner');
    const buzzerBtn = $('#buzzer');

    // 1. Stage Banner (shown during reading, buzzerOpen, answering, reveal)
    const activeStages = new Set(['stakeAuction', 'reading', 'buzzerOpen', 'answering', 'forAllAnswering', 'forAllJudge', 'reveal', 'appealVote', 'finalQuestion', 'finalJudge', 'paused']);
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

      if (game.phase === 'paused') {
        banner.classList.add('state-reading');
        $('#stage-icon').textContent = '⏸';
        $('#stage-title').textContent = 'Game paused';
        $('#stage-subtitle').textContent = 'Waiting for the host to resume.';
      } else if (game.phase === 'stakeAuction') {
        banner.classList.add('state-reading');
        $('#stage-icon').textContent = '🔨';
        $('#stage-title').textContent = 'Stake auction';
        $('#stage-subtitle').textContent = 'Players bid in turn for the right to answer.';
      } else if (game.phase === 'forAllAnswering') {
        banner.classList.add('state-reading');
        $('#stage-icon').textContent = '✍️';
        $('#stage-title').textContent = 'Everyone answers';
        $('#stage-subtitle').textContent = 'Submit your answer privately before time runs out.';
      } else if (game.phase === 'forAllJudge') {
        banner.classList.add('state-answering');
        $('#stage-icon').textContent = '⚖️';
        $('#stage-title').textContent = 'Judging all answers';
        $('#stage-subtitle').textContent = 'The host is reviewing submitted answers.';
      } else if (game.phase === 'appealVote') {
        banner.classList.add('state-answering');
        $('#stage-icon').textContent = '⚖️';
        $('#stage-title').textContent = 'Appeal vote';
        $('#stage-subtitle').textContent = 'Eligible players are reviewing the verdict.';
      } else if (game.phase === 'reading') {
        banner.classList.add('state-reading');
        $('#stage-icon').textContent = '📖';
        $('#stage-title').textContent = 'Reading question';
        $('#stage-subtitle').textContent = game.current?.type === 'forAll'
          ? 'Read the question. Private answers open after reading.'
          : !settings.falseStart ? 'You can buzz while the question plays.'
            : `Wait for the signal. Early buzz blocks you for ${settings.timeForBlockingButton}s.`;
      } else if (game.phase === 'buzzerOpen') {
        banner.classList.add('state-open');
        $('#stage-icon').textContent = '🟢';
        $('#stage-title').textContent = 'Buzz now!';
        $('#stage-subtitle').textContent = !settings.falseStart
          ? 'You can buzz while the question is being read.'
          : 'Press the buzzer or Space to answer.';
      } else if (game.phase === 'answering') {
        banner.classList.add('state-answering');
        const winner = participants.find((p) => p.id === game.buzzer.winnerId);
        const info = game.buzzer.winnerInfo;
        const timingNote = info?.reactionMs != null
          ? ` · ⏱️ ${info.reactionMs}ms (${info.mode === 'clientTimestamp' ? 'device press' : 'server time'})`
          : '';
        $('#stage-icon').textContent = settings.oral ? '🎤' : '✍️';
        $('#stage-title').textContent = `${settings.oral ? 'ANSWERING' : 'WRITTEN ANSWER'}: ${winner ? winner.name : 'Player'}${timingNote}`;
        if (!settings.oral) {
          const typed = game.buzzer.typedAnswer;
          $('#stage-subtitle').textContent = typed?.submitted
            ? 'Answer submitted. Waiting for the host verdict.'
            : typed?.closed ? 'Answer time ended. Waiting for the host verdict.'
              : you.id === game.buzzer.winnerId ? 'Type your private answer before time runs out.'
                : 'Waiting for the player to submit a private answer.';
        } else if (!t || remMs <= 0) {
          // The host still judges after the answer clock ends; make that handoff explicit.
          $('#stage-countdown').textContent = 'Time';
          $('#stage-subtitle').textContent = you.canModerate
            ? 'Answer time ended. Choose Correct or Wrong.'
            : 'Answer time ended — waiting for the host verdict.';
        } else {
          $('#stage-subtitle').textContent = you.canModerate
            ? 'Choose Correct or Wrong.'
            : 'Listen to the answer.';
        }
      } else if (game.phase === 'finalQuestion') {
        banner.classList.add('state-reading');
        $('#stage-icon').textContent = '🏆';
        $('#stage-title').textContent = 'Final question';
        $('#stage-subtitle').textContent = 'Prepare your answer before time runs out.';
      } else if (game.phase === 'finalJudge') {
        banner.classList.add('state-answering');
        $('#stage-icon').textContent = '⚖️';
        $('#stage-title').textContent = 'Final judging';
        $('#stage-subtitle').textContent = 'The host is checking every answer.';
      } else if (game.phase === 'reveal') {
        banner.classList.add('state-reveal');
        $('#stage-icon').textContent = '✅';
        $('#stage-title').textContent = `CORRECT ANSWER: ${(game.current?.right ?? []).join(' / ')}`;
        $('#stage-subtitle').textContent = 'Waiting for the next question.';
        $('#stage-countdown').textContent = '';
        $('#stage-progress-fill').style.width = '100%';
      }
    }

    // 2. Player Buzzer Button Orientier
    // Keep the fixed buzzer off finished phases so it cannot cover mobile appeal controls.
    const showBuzzer = you.role === 'player' && ['reading', 'buzzerOpen', 'answering'].includes(game.phase) &&
      (settings.oral || game.phase !== 'answering') &&
      game.current?.type !== 'forAll' && game.round?.type !== 'final';
    buzzerBtn.classList.toggle('hidden', !showBuzzer);
    buzzerBtn.classList.toggle('moderator-buzzer', !!you?.canModerate);
    if (!showBuzzer) return;

    buzzerBtn.classList.remove('buzz-reading', 'buzz-open', 'buzz-blocked', 'buzz-you-answering', 'buzz-idle');
    const blockedUntil = game.buzzer?.blockedUntil ?? 0;
    const isBlocked = blockedUntil > now;
    const alreadyTried = (game.buzzer?.attempted ?? []).includes(you.id);

    if (isBlocked) {
      const remBlock = ((blockedUntil - now) / 1000).toFixed(1);
      buzzerBtn.classList.add('buzz-blocked');
      $('#buzzer-main').textContent = `🚫 Blocked ${remBlock}s`;
      $('#buzzer-sub').textContent = 'You pressed before the signal.';
    } else if (alreadyTried && (game.phase === 'buzzerOpen' || game.phase === 'answering')) {
      buzzerBtn.classList.add('buzz-idle');
      $('#buzzer-main').textContent = '✘ Already answered';
      $('#buzzer-sub').textContent = 'Waiting for other players.';
    } else if (game.phase === 'reading') {
      buzzerBtn.classList.add(settings.falseStart ? 'buzz-reading' : 'buzz-open');
      $('#buzzer-main').textContent = settings.falseStart ? '✋ Wait for signal' : '🟢 Buzz now!';
      $('#buzzer-sub').textContent = settings.falseStart
        ? `Early press blocks you for ${settings.timeForBlockingButton}s.`
        : 'Press now to answer.';
    } else if (game.phase === 'buzzerOpen') {
      buzzerBtn.classList.add('buzz-open');
      $('#buzzer-main').textContent = '🟢 Buzz now!';
      $('#buzzer-sub').textContent = 'Tap or press Space.';
    } else if (game.phase === 'answering') {
      if (game.buzzer.winnerId === you.id) {
        buzzerBtn.classList.add('buzz-you-answering');
        $('#buzzer-main').textContent = '🎤 Your answer';
        $('#buzzer-sub').textContent = 'Tell the host your answer.';
      } else {
        const winner = participants.find((p) => p.id === game.buzzer.winnerId);
        buzzerBtn.classList.add('buzz-idle');
        $('#buzzer-main').textContent = `⏳ ${winner ? winner.name : 'Player'} answering`;
        $('#buzzer-sub').textContent = 'Get ready if they are wrong.';
      }
    } else {
      buzzerBtn.classList.add('buzz-idle');
      $('#buzzer-main').textContent = '⏸ Waiting for question';
      $('#buzzer-sub').textContent = 'Buzzer opens after selection.';
    }
  }

  /* ---------------- fast tick for smooth countdown bars ---------------- */

  setInterval(() => {
    if (!state?.game) return;
    const t = state.game.timer;
    $('#timer').textContent = t
      ? `${t.name} ${Math.max(0, Math.ceil((t.endsAt - nowServer()) / 1000))}s`
      : '';
    updateOrientiers();
  }, 100);

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

  for (const b of document.querySelectorAll<HTMLElement>('[data-act]')) {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (!act) return;
      if (act === 'game:stop' && !confirm('Stop this game? Scores and progress will be reset.')) return;
      if (act === 'game:next' && state?.game?.phase === 'specialSetup' &&
          !confirm('Skip this special question?')) return;
      if (act === 'judge-ok') send('game:judge', { correct: true });
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

/* Client UI with clear reading/buzzer orientiers & pre-game falseStart setting. */
(() => {
  const $ = (s) => document.querySelector(s);
  const TOKEN_KEY = 'sigame.token';
  const socket = io({ transports: ['websocket', 'polling'] });

  let state = null;
  let clockOffset = 0; // serverTime - Date.now()

  /* ---------------- Web Audio cues ---------------- */
  let audioCtx = null;
  function playTone(freq, durationMs, type = 'sine', secondFreq = null) {
    try {
      audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
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

  const send = (event, payload = {}) =>
    new Promise((resolve) =>
      socket.emit(event, payload, (res) => {
        if (!res?.ok) alert(res?.error ?? 'Request failed');
        resolve(res);
      }),
    );

  const show = (id) => {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  };

  const nowServer = () => Date.now() + clockOffset;

  /* ---------------- session ---------------- */

  socket.on('connect', () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return show('screen-join');
    socket.emit('session:resume', { token }, (res) => {
      if (!res?.resumed) {
        localStorage.removeItem(TOKEN_KEY);
        show('screen-join');
      }
    });
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('session:join', { nickname: $('#nickname').value }, (res) => {
      if (!res.ok) return ($('#join-error').textContent = res.error);
      localStorage.setItem(TOKEN_KEY, res.token);
    });
  });

  for (const b of document.querySelectorAll('[data-role]')) {
    b.addEventListener('click', () => send('role:choose', { role: b.dataset.role }));
  }

  socket.on('session:kicked', () => {
    localStorage.removeItem(TOKEN_KEY);
    alert('You were removed by the host');
    show('screen-join');
  });

  /* ---------------- state & events ---------------- */

  socket.on('room:state', (s) => {
    state = s;
    clockOffset = s.serverTime - Date.now();
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

  function renderHostControls() {
    const { you, game } = state;
    const mod = you.canModerate && game.phase !== 'lobby';
    $('#host-controls').classList.toggle('hidden', !mod);
    if (!mod) return;

    const openBtn = $('#btn-open-buzzer');
    if (openBtn) {
      openBtn.disabled = game.phase !== 'reading';
      openBtn.textContent =
        game.phase === 'reading' ? '🔓 Open buttons now (Открыть кнопки)' : '🟢 Buttons already open';
    }
  }

  function renderPlayers() {
    const { participants, game, you } = state;
    const now = nowServer();
    const blockedMap = new Map((game.buzzer?.blockedPlayers ?? []).map((b) => [b.id, b.until]));
    const attemptedSet = new Set(game.buzzer?.attempted ?? []);

    $('#players').innerHTML = '';
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
      el.querySelector('b').textContent = p.name;
      el.querySelector('small').textContent = p.role === 'player' ? `${p.score} pts` : p.role;

      const slot = el.querySelector('.badge-slot');
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
        plus.onclick = () => send('score:adjust', { targetId: p.id, delta: 100 });
        minus.onclick = () => send('score:adjust', { targetId: p.id, delta: -100 });
        row.append(plus, minus);
        el.append(row);
      }
      $('#players').append(el);
    }
  }

  /* ---------------- lobby settings & packs ---------------- */

  let packsLoaded = false;
  async function refreshPacks() {
    const res = await send('packs:list');
    if (!res.ok) return;
    $('#pack-list').innerHTML = '';
    for (const p of res.packs) {
      const li = document.createElement('li');
      const btn = Object.assign(document.createElement('button'), { textContent: 'Load' });
      btn.onclick = () => send('packs:load', { file: p.file });
      li.append(btn, ` ${p.name} (${p.rounds ?? '?'} rounds, ${(p.size / 1e6).toFixed(1)} MB)`);
      $('#pack-list').append(li);
    }
  }

  function renderManage() {
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

    // Sync settings inputs
    const s = state.settings;
    if (document.activeElement !== $('#set-falseStart')) $('#set-falseStart').checked = !!s.falseStart;
    $('#set-falseStart-desc').textContent = s.falseStart
      ? 'ON (Вкл): Players must wait until the question is read (amber border). Pressing early = false start penalty (' +
        s.timeForBlockingButton +
        's block).'
      : 'OFF (Выкл): Buzzers open immediately as soon as the question appears (green border). Players can buzz while reading.';

    const numFields = [
      'timeForBlockingButton',
      'readingSpeed',
      'timeForThinkingOnQuestion',
      'timeForPrintingAnswer',
    ];
    for (const key of numFields) {
      const input = $(`#set-${key}`);
      if (input && document.activeElement !== input) input.value = s[key];
      if (input && key === 'timeForBlockingButton') input.disabled = !s.falseStart;
    }
    if (document.activeElement !== $('#set-ignoreWrong')) {
      $('#set-ignoreWrong').checked = !!s.ignoreWrong;
    }
  }

  // Settings change listeners
  $('#set-falseStart').addEventListener('change', (e) => {
    send('settings:update', { falseStart: e.target.checked });
  });
  $('#set-ignoreWrong').addEventListener('change', (e) => {
    send('settings:update', { ignoreWrong: e.target.checked });
  });
  for (const key of ['timeForBlockingButton', 'readingSpeed', 'timeForThinkingOnQuestion', 'timeForPrintingAnswer']) {
    $(`#set-${key}`).addEventListener('change', (e) => {
      const val = Number.parseInt(e.target.value, 10);
      if (Number.isFinite(val)) send('settings:update', { [key]: val });
    });
  }

  /* ---------------- board & question ---------------- */

  function renderBoard() {
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
        el.textContent = cell?.price ?? '';
        if (cell?.available && canPick) el.onclick = () => send('game:select', { themeIndex: t, questionIndex: q });
        board.append(el);
      }
    });
  }

  function createMediaPlayer(type, url) {
    const wrap = document.createElement('div');
    wrap.className = 'media-wrap';

    const el = document.createElement(type);
    el.controls = true;
    el.preload = 'auto';
    el.autoplay = true;
    if (type === 'video') {
      // Required for iPhone / iPad Safari inline playback
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
    }
    el.src = url;
    wrap.append(el);

    const status = document.createElement('div');
    status.className = 'media-status hidden';
    wrap.append(status);

    // Explicitly invoke .play() and handle iOS Safari autoplay restrictions
    const tryPlay = () => {
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          status.classList.add('hidden');
        }).catch(() => {
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

    const showTapToPlay = () => {
      status.className = 'media-status';
      status.innerHTML = '';
      const btn = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'media-tap-btn',
        textContent: type === 'video' ? '▶️ Запустить видео (Tap to play video)' : '▶️ Запустить аудио (Tap to play audio)',
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
    el.addEventListener('loadedmetadata', tryPlay, { once: true });
    setTimeout(tryPlay, 50);

    return wrap;
  }

  function contentHtml(items) {
    const div = document.createElement('div');
    for (const it of items ?? []) {
      let el;
      if (it.type === 'image' && it.url) el = Object.assign(document.createElement('img'), { src: it.url });
      else if ((it.type === 'audio' || it.type === 'video') && it.url) el = createMediaPlayer(it.type, it.url);
      else el = Object.assign(document.createElement('p'), { textContent: it.missing ? `[missing ${it.type}: ${it.value}]` : it.value });
      div.append(el);
    }
    return div;
  }

  let renderedQuestionKey = null;
  function renderQuestion() {
    const { game } = state;
    const c = game.current;
    const box = $('#question');
    box.classList.toggle('hidden', !c);

    // Update glowing border frame around question card to match stage
    box.classList.remove('frame-reading', 'frame-open', 'frame-answering');
    if (game.phase === 'reading') box.classList.add('frame-reading');
    else if (game.phase === 'buzzerOpen') box.classList.add('frame-open');
    else if (game.phase === 'answering') box.classList.add('frame-answering');

    if (!c) return (renderedQuestionKey = null);
    // Avoid restarting media on every state update.
    const key = `${game.roundIndex}:${c.themeIndex}:${c.questionIndex}:${!!c.right}`;
    if (key === renderedQuestionKey) return;
    renderedQuestionKey = key;

    box.innerHTML = '';
    box.append(Object.assign(document.createElement('h3'), { textContent: `${c.themeName} · ${c.price}${c.type !== 'simple' ? ` · ${c.type}` : ''}` }));
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

  function updateOrientiers() {
    if (!state?.game) return;
    const { game, you, participants, settings } = state;
    const now = nowServer();
    const banner = $('#stage-banner');
    const buzzerBtn = $('#buzzer');

    // 1. Stage Banner (shown during reading, buzzerOpen, answering, reveal)
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
        $('#stage-subtitle').textContent =
          `⚠️ Фальшстарт активен: раннее нажатие заблокирует кнопку на ${settings.timeForBlockingButton} сек.`;
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
        $('#stage-icon').textContent = '🎤';
        $('#stage-title').textContent = `ANSWERING: ${winner ? winner.name : 'Player'} (Отвечает игрок)`;
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

    // 2. Player Buzzer Button Orientier
    const showBuzzer = you?.role === 'player' && game.phase !== 'lobby';
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
    $('#timer').textContent = t
      ? `${t.name} ${Math.max(0, Math.ceil((t.endsAt - nowServer()) / 1000))}s`
      : '';
    updateOrientiers();
  }, 100);

  /* ---------------- controls ---------------- */

  $('#buzzer').addEventListener('pointerdown', () => socket.emit('game:buzz', {}, () => {}));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && state?.you?.role === 'player' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      socket.emit('game:buzz', {}, () => {});
    }
  });

  for (const b of document.querySelectorAll('[data-act]')) {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'judge-ok') send('game:judge', { correct: true });
      else if (act === 'judge-bad') send('game:judge', { correct: false });
      else send(act);
    });
  }

  $('#btn-start').addEventListener('click', () => send('game:start'));

  $('#steam-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#steam-log').textContent = '';
    send('steam:download', { link: $('#steam-link').value });
  });
  socket.on('steam:progress', (p) => {
    const log = $('#steam-log');
    log.textContent += `[${p.stage}] ${p.message}${p.percent != null ? ` (${p.percent}%)` : ''}\n`;
    log.scrollTop = log.scrollHeight;
  });
  socket.on('packs:changed', () => refreshPacks());
})();

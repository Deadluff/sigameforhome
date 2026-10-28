/**
 * Game engine: the round/board/question/buzzer state machine.
 *
 * Scope of this first iteration (Step 2):
 *   ✔ rounds & board, question selection by chooser or host
 *   ✔ reading phase with SIGame-style false starts
 *   ✔ buzzer (first-wins or random-within-interval), answer judging, scoring
 *   ✔ round timer, server-side countdowns (clients only render `endsAt`)
 *   ✘ special question flows (secret/stake/noRisk/forAll) & final round – Step 6.
 *     They are already parsed and flagged in `current.type`; for now they play like simple questions.
 *
 * The engine never talks to sockets. It mutates state and calls room.changed()
 * / room.emitEvent(); the transport layer decides who receives what.
 */
import { PHASES, ROLES } from './constants.js';

const QUESTION_PHASES = new Set([PHASES.READING, PHASES.BUZZER_OPEN, PHASES.ANSWERING, PHASES.REVEAL]);

export class GameEngine {
  /** @param {import('./Room.js').Room} room */
  constructor(room) {
    this.room = room;
    this.reset();
  }

  reset() {
    this.clearTimer();
    this.phase = PHASES.LOBBY;
    this.roundIndex = -1;
    this.played = new Set(); // "round:theme:question"
    this.chooserId = null;
    this.current = null;
    this.roundEndsAt = null;
    this.resetBuzzer();
  }

  resetBuzzer() {
    clearTimeout(this.buzzWindowHandle);
    this.buzzer = {
      winnerId: null,
      attempted: new Set(), // players who already answered this question
      blockedUntil: new Map(), // false-start penalties: playerId → epoch ms
      pending: [], // presses collected inside the random window
      remainingMs: null, // thinking time left when a player buzzed (resumed after a wrong answer)
    };
  }

  /* ----------------------------------------------------------------- helpers */

  get settings() {
    return this.room.settings;
  }

  get pack() {
    return this.room.loadedPack?.pack ?? null;
  }

  get round() {
    return this.pack?.rounds[this.roundIndex] ?? null;
  }

  activePlayers() {
    return this.room.players().filter((p) => p.connected);
  }

  isAvailable(t, q) {
    const question = this.round?.themes[t]?.questions[q];
    return !!question && question.price >= 0 && !this.played.has(`${this.roundIndex}:${t}:${q}`);
  }

  roundHasQuestionsLeft() {
    return !!this.round?.themes.some((theme, t) => theme.questions.some((_, q) => this.isAvailable(t, q)));
  }

  assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  /* ------------------------------------------------------------------ timers */

  /** One active countdown at a time; its `endsAt` is broadcast so clients render it locally. */
  startTimer(name, seconds, onExpire) {
    this.clearTimer();
    if (!seconds || seconds <= 0) return;
    const durationMs = seconds * 1000;
    this.timer = {
      name,
      durationMs,
      endsAt: Date.now() + durationMs,
      handle: setTimeout(() => {
        this.timer = null;
        try {
          onExpire?.();
        } catch (err) {
          console.warn(`[engine] timer "${name}" expiry ignored: ${err.message}`);
        }
        this.room.changed();
      }, durationMs),
    };
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer.handle);
    this.timer = null;
  }

  /* ---------------------------------------------------------------- flow */

  start() {
    this.assert(this.pack, 'Load a pack first');
    this.assert(this.pack.rounds.length > 0, 'This pack has no rounds');
    this.assert(this.room.players().length > 0, 'At least one player is required');
    this.reset();
    for (const p of this.room.players()) p.score = 0;
    this.enterRound(0);
  }

  stop() {
    this.reset();
  }

  enterRound(index) {
    this.clearTimer();
    this.roundIndex = index;
    this.current = null;
    this.resetBuzzer();
    this.phase = PHASES.BOARD;
    this.roundEndsAt = this.settings.timeOfRound > 0 ? Date.now() + this.settings.timeOfRound * 1000 : null;

    // SIGame: random chooser in the first round, then the lowest score chooses.
    const players = this.room.players();
    if (index === 0 || !players.length) {
      this.chooserId = players.length ? players[Math.floor(Math.random() * players.length)].id : null;
    } else {
      this.chooserId = [...players].sort((a, b) => a.score - b.score)[0].id;
    }
    this.startChoosingTimer();
  }

  startChoosingTimer() {
    // Informational only: a human host can always pick on behalf of the chooser.
    this.startTimer('choosing', this.settings.timeForChoosingQuestion);
  }

  nextRound() {
    this.assert(this.pack, 'No pack loaded');
    if (this.roundIndex + 1 < this.pack.rounds.length) this.enterRound(this.roundIndex + 1);
    else this.finish();
  }

  finish() {
    this.clearTimer();
    this.current = null;
    this.phase = PHASES.GAME_OVER;
  }

  /**
   * @param {string} actorId participant requesting the selection
   * @param {boolean} actorIsModerator host may pick for anyone
   */
  selectQuestion(actorId, actorIsModerator, themeIndex, questionIndex) {
    this.assert(this.phase === PHASES.BOARD, 'You cannot choose a question right now');
    this.assert(actorIsModerator || actorId === this.chooserId, 'It is not your turn to choose');
    this.assert(this.isAvailable(themeIndex, questionIndex), 'This question is not available');

    const theme = this.round.themes[themeIndex];
    const question = theme.questions[questionIndex];
    this.played.add(`${this.roundIndex}:${themeIndex}:${questionIndex}`);
    this.resetBuzzer();

    this.current = {
      themeIndex,
      questionIndex,
      themeName: theme.name,
      price: question.price,
      // In "simple" game mode every question is played as a regular one (SIGame GameMode.Simple).
      type: this.settings.gameMode === 'simple' ? 'simple' : question.type,
      question,
      answerShown: false,
    };
    this.phase = PHASES.READING;
    this.room.emitEvent({ type: 'questionSelected', themeIndex, questionIndex, price: question.price });

    if (!this.settings.falseStart) {
      // Фальшстарт выключен: кнопки активны сразу при появлении вопроса,
      // но даём время на чтение + время на размышление.
      const totalSeconds = this.estimateReadingSeconds(question) + this.settings.timeForThinkingOnQuestion;
      this.openBuzzer(totalSeconds);
    } else {
      // Фальшстарт включён: нажатие во время чтения блокирует кнопку.
      // Кнопки откроются автоматически после окончания чтения (или досрочно ведущим).
      this.startTimer('reading', this.estimateReadingSeconds(question), () => this.openBuzzer());
    }
  }

  /** Estimates how long the question takes to present, using SIGame's ReadingSpeed. */
  estimateReadingSeconds(question) {
    let seconds = 0;
    for (const item of question.content) {
      if (item.type === 'text' || item.type === 'say') seconds += item.value.length / this.settings.readingSpeed;
      else if (item.duration) seconds += item.duration;
      else if (item.type === 'image') seconds += 2;
      else if (item.type === 'audio' || item.type === 'video') seconds += 10; // unknown length; host can open early
    }
    return Math.max(1, Math.ceil(seconds + this.settings.timeForMediaDelay));
  }

  openBuzzer(overrideSeconds) {
    this.assert(this.phase === PHASES.READING || this.phase === PHASES.ANSWERING, 'Buttons cannot be opened now');
    this.phase = PHASES.BUZZER_OPEN;
    this.buzzer.winnerId = null;
    const seconds =
      overrideSeconds != null
        ? overrideSeconds
        : this.buzzer.remainingMs != null
          ? this.buzzer.remainingMs / 1000
          : this.settings.timeForThinkingOnQuestion;
    this.startTimer('buzzer', seconds, () => this.revealAnswer());
    this.room.emitEvent({ type: 'buzzerOpen' });
  }

  /** @returns {{ result: 'accepted'|'falseStart'|'queued'|'ignored' }} */
  buzz(playerId) {
    const now = Date.now();
    const player = this.room.participants.get(playerId);
    if (!player || player.role !== ROLES.PLAYER) return { result: 'ignored' };

    if (this.phase === PHASES.READING) {
      if (!this.settings.falseStart) return { result: 'ignored' };
      // SIGame false start: the button is locked for TimeForBlockingButton seconds.
      this.buzzer.blockedUntil.set(playerId, now + this.settings.timeForBlockingButton * 1000);
      this.room.emitEvent({ type: 'falseStart', playerId });
      this.room.changed();
      return { result: 'falseStart' };
    }

    if (this.phase !== PHASES.BUZZER_OPEN) return { result: 'ignored' };
    if (this.buzzer.attempted.has(playerId)) return { result: 'ignored' };
    if ((this.buzzer.blockedUntil.get(playerId) ?? 0) > now) return { result: 'ignored' };

    if (this.settings.buttonPressMode === 'randomWithinInterval' && this.settings.buttonPressIntervalMs > 0) {
      if (!this.buzzer.pending.includes(playerId)) this.buzzer.pending.push(playerId);
      if (this.buzzer.pending.length === 1) {
        this.buzzWindowHandle = setTimeout(() => {
          const pool = this.buzzer.pending;
          this.buzzer.pending = [];
          if (this.phase === PHASES.BUZZER_OPEN && pool.length) {
            this.grantAnswer(pool[Math.floor(Math.random() * pool.length)]);
            this.room.changed();
          }
        }, this.settings.buttonPressIntervalMs);
      }
      return { result: 'queued' };
    }

    this.grantAnswer(playerId);
    this.room.changed();
    return { result: 'accepted' };
  }

  grantAnswer(playerId) {
    // Pause the thinking timer: remaining time is restored if the answer is wrong.
    this.buzzer.remainingMs = this.timer ? Math.max(1000, this.timer.endsAt - Date.now()) : null;
    this.buzzer.winnerId = playerId;
    this.phase = PHASES.ANSWERING;
    this.startTimer('answering', this.settings.timeForPrintingAnswer);
    this.room.emitEvent({ type: 'buzzAccepted', playerId });
  }

  /** Host verdict on the current answer. */
  judge(correct) {
    this.assert(this.phase === PHASES.ANSWERING && this.buzzer.winnerId, 'Nobody is answering');
    const player = this.room.participants.get(this.buzzer.winnerId);
    const price = this.current.price;

    if (correct) {
      if (player) player.score += price;
      this.chooserId = this.buzzer.winnerId;
      this.room.emitEvent({ type: 'answerJudged', playerId: this.buzzer.winnerId, correct: true, delta: price });
      this.revealAnswer();
      return;
    }

    const delta = this.settings.ignoreWrong ? 0 : -price;
    if (player) player.score += delta;
    this.buzzer.attempted.add(this.buzzer.winnerId);
    this.room.emitEvent({ type: 'answerJudged', playerId: this.buzzer.winnerId, correct: false, delta });

    const someoneLeft = this.activePlayers().some((p) => !this.buzzer.attempted.has(p.id));
    if (someoneLeft) this.openBuzzer();
    else this.revealAnswer();
  }

  revealAnswer() {
    this.assert(QUESTION_PHASES.has(this.phase), 'No active question');
    this.clearTimer();
    clearTimeout(this.buzzWindowHandle);
    this.phase = PHASES.REVEAL;
    this.current.answerShown = true;
  }

  /** Leaves the current question (or skips it) and returns to the board / ends the round. */
  next() {
    if (this.phase === PHASES.ROUND_END) return this.nextRound();
    this.assert(QUESTION_PHASES.has(this.phase), 'Nothing to continue');
    this.clearTimer();
    this.current = null;
    this.resetBuzzer();

    const outOfTime = this.roundEndsAt && Date.now() >= this.roundEndsAt;
    if (!this.roundHasQuestionsLeft() || outOfTime) {
      this.phase = PHASES.ROUND_END;
      this.room.emitEvent({ type: 'roundEnd', roundIndex: this.roundIndex, outOfTime: !!outOfTime });
    } else {
      this.phase = PHASES.BOARD;
      this.startChoosingTimer();
    }
  }

  /* ------------------------------------------------------------------ views */

  /**
   * Role-aware projection of the state. Players never receive answers before the reveal,
   * and nobody receives question content before it is selected.
   */
  getView(viewer, canModerate) {
    const round = this.round;
    const c = this.current;
    const showAnswer = canModerate || (c?.answerShown ?? false);

    return {
      phase: this.phase,
      roundIndex: this.roundIndex,
      round: round && { name: round.name, type: round.type },
      roundEndsAt: this.roundEndsAt,
      board:
        round?.themes.map((theme, t) => ({
          name: theme.name,
          questions: theme.questions.map((q, i) => ({ price: q.price, available: this.isAvailable(t, i) })),
        })) ?? [],
      chooserId: this.chooserId,
      timer: this.timer && { name: this.timer.name, endsAt: this.timer.endsAt, durationMs: this.timer.durationMs },
      current: c && {
        themeIndex: c.themeIndex,
        questionIndex: c.questionIndex,
        themeName: c.themeName,
        price: c.price,
        type: c.type,
        content: c.question.content,
        answerShown: c.answerShown,
        right: showAnswer ? c.question.right : null,
        wrong: canModerate ? c.question.wrong : null,
        answerContent: showAnswer ? c.question.answerContent : null,
        comments: showAnswer ? c.question.info.comments : null,
        sources: showAnswer && this.settings.displaySources ? c.question.info.sources : null,
      },
      buzzer: {
        winnerId: this.buzzer.winnerId,
        attempted: [...this.buzzer.attempted],
        blockedUntil: viewer ? (this.buzzer.blockedUntil.get(viewer.id) ?? null) : null,
        blockedPlayers: [...this.buzzer.blockedUntil.entries()]
          .filter(([, until]) => until > Date.now())
          .map(([id, until]) => ({ id, until })),
      },
    };
  }
}

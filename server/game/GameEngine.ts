/**
 * Game engine: the round/board/question/buzzer state machine.
 */
import type { ContentItem, Package, Question, QuestionType, Round } from '../packs/siqParser.ts';
import { PHASES, type Phase, ROLES } from './constants.ts';
import type { Participant, Room } from './Room.ts';
import type { GameSettings } from './settings.ts';

const QUESTION_PHASES = new Set<Phase>([PHASES.READING, PHASES.BUZZER_OPEN, PHASES.ANSWERING, PHASES.REVEAL]);

export interface ActiveTimer {
  name: string;
  durationMs: number;
  endsAt: number;
  handle: ReturnType<typeof setTimeout>;
}

export interface WinnerInfo {
  mode: 'server' | 'clientTimestamp' | 'random';
  reactionMs: number;
  transitMs?: number;
  contenders?: number;
}

export interface PendingBuzz {
  playerId: string;
  serverAt: number;
  effectiveAt: number;
  transitMs?: number;
}

export interface BuzzerState {
  winnerId: string | null;
  winnerInfo: WinnerInfo | null;
  openedAt: number | null;
  attempted: Set<string>;
  blockedUntil: Map<string, number>;
  pending: PendingBuzz[];
  remainingMs: number | null;
}

export interface CurrentQuestionState {
  themeIndex: number;
  questionIndex: number;
  themeName: string;
  price: number;
  type: QuestionType;
  question: Question;
  answerShown: boolean;
}

export type BuzzResult = 'accepted' | 'falseStart' | 'queued' | 'ignored';

export interface GameView {
  phase: Phase;
  roundIndex: number;
  round: { name: string; type: Round['type'] } | null;
  roundEndsAt: number | null;
  board: Array<{
    name: string;
    questions: Array<{ price: number; available: boolean }>;
  }>;
  chooserId: string | null;
  timer: { name: string; endsAt: number; durationMs: number } | null;
  current: {
    themeIndex: number;
    questionIndex: number;
    themeName: string;
    price: number;
    type: QuestionType;
    content: ContentItem[];
    answerShown: boolean;
    right: string[] | null;
    wrong: string[] | null;
    answerContent: ContentItem[] | null;
    comments: string | null;
    sources: string[] | null;
  } | null;
  buzzer: {
    winnerId: string | null;
    winnerInfo: WinnerInfo | null;
    attempted: string[];
    blockedUntil: number | null;
    blockedPlayers: Array<{ id: string; until: number }>;
  };
}

export class GameEngine {
  readonly room: Room;
  phase!: Phase;
  roundIndex!: number;
  played!: Set<string>;
  chooserId!: string | null;
  current!: CurrentQuestionState | null;
  roundEndsAt!: number | null;
  timer: ActiveTimer | null = null;
  buzzWindowHandle?: ReturnType<typeof setTimeout>;
  buzzer!: BuzzerState;

  constructor(room: Room) {
    this.room = room;
    this.reset();
  }

  reset(): void {
    this.clearTimer();
    this.phase = PHASES.LOBBY;
    this.roundIndex = -1;
    this.played = new Set<string>();
    this.chooserId = null;
    this.current = null;
    this.roundEndsAt = null;
    this.resetBuzzer();
  }

  resetBuzzer(): void {
    clearTimeout(this.buzzWindowHandle);
    this.buzzer = {
      winnerId: null,
      winnerInfo: null,
      openedAt: null,
      attempted: new Set<string>(),
      blockedUntil: new Map<string, number>(),
      pending: [],
      remainingMs: null,
    };
  }

  /* ----------------------------------------------------------------- helpers */

  get settings(): GameSettings {
    return this.room.settings;
  }

  get pack(): Package | null {
    return this.room.loadedPack?.pack ?? null;
  }

  get round(): Round | null {
    return this.pack?.rounds[this.roundIndex] ?? null;
  }

  activePlayers(): Participant[] {
    return this.room.players().filter((p) => p.connected);
  }

  isAvailable(t: number, q: number): boolean {
    const question = this.round?.themes[t]?.questions[q];
    return !!question && question.price >= 0 && !this.played.has(`${this.roundIndex}:${t}:${q}`);
  }

  roundHasQuestionsLeft(): boolean {
    return !!this.round?.themes.some((theme, t) => theme.questions.some((_, q) => this.isAvailable(t, q)));
  }

  assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }

  /* ------------------------------------------------------------------ timers */

  startTimer(name: string, seconds: number, onExpire?: () => void): void {
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
          console.warn(`[engine] timer "${name}" expiry ignored: ${(err as Error).message}`);
        }
        this.room.changed();
      }, durationMs),
    };
  }

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer.handle);
    this.timer = null;
  }

  /* ---------------------------------------------------------------- flow */

  start(): void {
    this.assert(this.pack, 'Load a pack first');
    this.assert(this.pack.rounds.length > 0, 'This pack has no rounds');
    this.assert(this.room.players().length > 0, 'At least one player is required');
    this.reset();
    for (const p of this.room.players()) p.score = 0;
    this.enterRound(0);
  }

  stop(): void {
    this.reset();
  }

  enterRound(index: number): void {
    this.clearTimer();
    this.roundIndex = index;
    this.current = null;
    this.resetBuzzer();
    this.phase = PHASES.BOARD;
    this.roundEndsAt = this.settings.timeOfRound > 0 ? Date.now() + this.settings.timeOfRound * 1000 : null;

    const players = this.room.players();
    if (index === 0 || !players.length) {
      this.chooserId = players.length ? players[Math.floor(Math.random() * players.length)].id : null;
    } else {
      this.chooserId = [...players].sort((a, b) => a.score - b.score)[0].id;
    }
    this.startChoosingTimer();
  }

  startChoosingTimer(): void {
    this.startTimer('choosing', this.settings.timeForChoosingQuestion);
  }

  nextRound(): void {
    this.assert(this.pack, 'No pack loaded');
    if (this.roundIndex + 1 < this.pack.rounds.length) this.enterRound(this.roundIndex + 1);
    else this.finish();
  }

  finish(): void {
    this.clearTimer();
    this.current = null;
    this.phase = PHASES.GAME_OVER;
  }

  selectQuestion(actorId: string, actorIsModerator: boolean, themeIndex: number, questionIndex: number): void {
    this.assert(this.phase === PHASES.BOARD, 'You cannot choose a question right now');
    this.assert(actorIsModerator || actorId === this.chooserId, 'It is not your turn to choose');
    this.assert(this.isAvailable(themeIndex, questionIndex), 'This question is not available');
    this.assert(this.round, 'No active round');

    const theme = this.round.themes[themeIndex];
    const question = theme.questions[questionIndex];
    this.played.add(`${this.roundIndex}:${themeIndex}:${questionIndex}`);
    this.resetBuzzer();

    this.current = {
      themeIndex,
      questionIndex,
      themeName: theme.name,
      price: question.price,
      type: this.settings.gameMode === 'simple' ? 'simple' : question.type,
      question,
      answerShown: false,
    };
    this.phase = PHASES.READING;
    this.room.emitEvent({ type: 'questionSelected', themeIndex, questionIndex, price: question.price });

    if (!this.settings.falseStart) {
      const totalSeconds = this.estimateReadingSeconds(question) + this.settings.timeForThinkingOnQuestion;
      this.openBuzzer(totalSeconds);
    } else {
      this.startTimer('reading', this.estimateReadingSeconds(question), () => this.openBuzzer());
    }
  }

  estimateReadingSeconds(question: Question): number {
    let seconds = 0;
    for (const item of question.content) {
      if (item.type === 'text' || item.type === 'say') seconds += item.value.length / this.settings.readingSpeed;
      else if (item.duration) seconds += item.duration;
      else if (item.type === 'image') seconds += 2;
      else if (item.type === 'audio' || item.type === 'video') seconds += 10;
    }
    return Math.max(1, Math.ceil(seconds + this.settings.timeForMediaDelay));
  }

  openBuzzer(overrideSeconds?: number): void {
    this.assert(this.phase === PHASES.READING || this.phase === PHASES.ANSWERING, 'Buttons cannot be opened now');
    clearTimeout(this.buzzWindowHandle);
    this.phase = PHASES.BUZZER_OPEN;
    this.buzzer.winnerId = null;
    this.buzzer.winnerInfo = null;
    this.buzzer.pending = [];
    this.buzzer.openedAt = Date.now();
    const seconds =
      overrideSeconds != null
        ? overrideSeconds
        : this.buzzer.remainingMs != null
          ? this.buzzer.remainingMs / 1000
          : this.settings.timeForThinkingOnQuestion;
    this.startTimer('buzzer', seconds, () => this.revealAnswer());
    this.room.emitEvent({ type: 'buzzerOpen', openedAt: this.buzzer.openedAt });
  }

  resolvePressTimestamp(serverNow: number, rawClientAt?: unknown): number {
    const openedAt = this.buzzer.openedAt ?? serverNow;
    const num = Number(rawClientAt);
    if (!Number.isFinite(num)) return serverNow;
    const minAllowed = Math.max(openedAt, serverNow - 2000);
    const maxAllowed = serverNow + 20;
    return Math.min(maxAllowed, Math.max(minAllowed, num));
  }

  buzz(playerId: string, meta: { clientAt?: number } = {}): { result: BuzzResult } {
    const now = Date.now();
    const player = this.room.participants.get(playerId);
    if (!player || player.role !== ROLES.PLAYER) return { result: 'ignored' };

    if (this.phase === PHASES.READING) {
      if (!this.settings.falseStart) return { result: 'ignored' };
      this.buzzer.blockedUntil.set(playerId, now + this.settings.timeForBlockingButton * 1000);
      this.room.emitEvent({ type: 'falseStart', playerId });
      this.room.changed();
      return { result: 'falseStart' };
    }

    if (this.phase !== PHASES.BUZZER_OPEN) return { result: 'ignored' };
    if (this.buzzer.attempted.has(playerId)) return { result: 'ignored' };
    if ((this.buzzer.blockedUntil.get(playerId) ?? 0) > now) return { result: 'ignored' };

    if (this.settings.buttonPressMode === 'randomWithinInterval' && this.settings.buttonPressIntervalMs > 0) {
      if (!this.buzzer.pending.some((p) => p.playerId === playerId)) {
        this.buzzer.pending.push({ playerId, serverAt: now, effectiveAt: now });
      }
      if (this.buzzer.pending.length === 1) {
        this.buzzWindowHandle = setTimeout(() => {
          const pool = this.buzzer.pending;
          this.buzzer.pending = [];
          if (this.phase === PHASES.BUZZER_OPEN && pool.length) {
            const chosen = pool[Math.floor(Math.random() * pool.length)];
            this.grantAnswer(chosen.playerId, {
              mode: 'random',
              reactionMs: chosen.serverAt - (this.buzzer.openedAt ?? chosen.serverAt),
            });
            this.room.changed();
          }
        }, this.settings.buttonPressIntervalMs);
      }
      return { result: 'queued' };
    }

    if (this.settings.buzzSyncMode === 'clientTimestamp' && this.settings.buzzSyncWindowMs > 0) {
      const effectiveAt = this.resolvePressTimestamp(now, meta?.clientAt);
      if (!this.buzzer.pending.some((p) => p.playerId === playerId)) {
        this.buzzer.pending.push({
          playerId,
          serverAt: now,
          effectiveAt,
          transitMs: Math.max(0, Math.round(now - effectiveAt)),
        });
      }
      if (this.buzzer.pending.length === 1) {
        this.buzzWindowHandle = setTimeout(() => {
          const pool = this.buzzer.pending;
          this.buzzer.pending = [];
          if (this.phase === PHASES.BUZZER_OPEN && pool.length) {
            pool.sort((a, b) => a.effectiveAt - b.effectiveAt || a.serverAt - b.serverAt);
            const winner = pool[0];
            this.grantAnswer(winner.playerId, {
              mode: 'clientTimestamp',
              reactionMs: Math.max(0, Math.round(winner.effectiveAt - (this.buzzer.openedAt ?? winner.effectiveAt))),
              transitMs: winner.transitMs,
              contenders: pool.length,
            });
            this.room.changed();
          }
        }, this.settings.buzzSyncWindowMs);
      }
      return { result: 'queued' };
    }

    this.grantAnswer(playerId, {
      mode: 'server',
      reactionMs: Math.max(0, Math.round(now - (this.buzzer.openedAt ?? now))),
    });
    this.room.changed();
    return { result: 'accepted' };
  }

  grantAnswer(playerId: string, winnerInfo: WinnerInfo | null = null): void {
    this.buzzer.remainingMs = this.timer ? Math.max(1000, this.timer.endsAt - Date.now()) : null;
    this.buzzer.winnerId = playerId;
    this.buzzer.winnerInfo = winnerInfo;
    this.phase = PHASES.ANSWERING;
    this.startTimer('answering', this.settings.timeForPrintingAnswer);
    this.room.emitEvent({ type: 'buzzAccepted', playerId, winnerInfo });
  }

  judge(correct: boolean): void {
    this.assert(this.phase === PHASES.ANSWERING && this.buzzer.winnerId, 'Nobody is answering');
    this.assert(this.current, 'No active question');
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

  revealAnswer(): void {
    this.assert(QUESTION_PHASES.has(this.phase), 'No active question');
    this.assert(this.current, 'No active question');
    this.clearTimer();
    clearTimeout(this.buzzWindowHandle);
    this.phase = PHASES.REVEAL;
    this.current.answerShown = true;
  }

  next(): void {
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

  getView(viewer: Participant | null, canModerate: boolean): GameView {
    const round = this.round;
    const c = this.current;
    const showAnswer = canModerate || (c?.answerShown ?? false);

    return {
      phase: this.phase,
      roundIndex: this.roundIndex,
      round: round ? { name: round.name, type: round.type } : null,
      roundEndsAt: this.roundEndsAt,
      board:
        round?.themes.map((theme, t) => ({
          name: theme.name,
          questions: theme.questions.map((q, i) => ({ price: q.price, available: this.isAvailable(t, i) })),
        })) ?? [],
      chooserId: this.chooserId,
      timer: this.timer ? { name: this.timer.name, endsAt: this.timer.endsAt, durationMs: this.timer.durationMs } : null,
      current: c
        ? {
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
          }
        : null,
      buzzer: {
        winnerId: this.buzzer.winnerId,
        winnerInfo: this.buzzer.winnerInfo,
        attempted: [...this.buzzer.attempted],
        blockedUntil: viewer ? (this.buzzer.blockedUntil.get(viewer.id) ?? null) : null,
        blockedPlayers: [...this.buzzer.blockedUntil.entries()]
          .filter(([, until]) => until > Date.now())
          .map(([id, until]) => ({ id, until })),
      },
    };
  }
}

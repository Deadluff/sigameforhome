/**
 * Game engine: the round/board/question/buzzer state machine.
 *
 * Supported flows:
 *   ✔ rounds & board, question selection by chooser or host
 *   ✔ reading phase with SIGame-style false starts
 *   ✔ buzzer (first-wins or random-within-interval), answer judging, scoring
 *   ✔ round timer, server-side countdowns (clients only render `endsAt`)
 *   ✔ guided secrets, stake auctions, no-risk scoring, and final wagers/judging
 *   ✔ guided for-all private answers and individual judging
 *
 * The engine never talks to sockets. It mutates state and calls room.changed()
 * / room.emitEvent(); the transport layer decides who receives what.
 */
import type { ContentItem, Package, Question, QuestionType, Round } from '../packs/siqParser.ts';
import { PHASES, type Phase, ROLES } from './constants.ts';
import type { Participant, Room } from './Room.ts';
import type { GameSettings } from './settings.ts';

const QUESTION_PHASES = new Set<Phase>([PHASES.READING, PHASES.BUZZER_OPEN, PHASES.ANSWERING, PHASES.FOR_ALL_ANSWERING, PHASES.FOR_ALL_JUDGE, PHASES.REVEAL]);

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
  assignedId: string | null;
  chooserBeforeQuestion: string | null;
  judgments: Judgment[];
}

export interface Judgment {
  id: number;
  playerId: string;
  correct: boolean;
  delta: number;
  rightDelta: number;
  wrongDelta: number;
  kind: string;
  appealed: boolean;
  voided: boolean;
}

interface StakeAuction {
  order: string[];
  turnIndex: number;
  leaderId: string | null;
  amount: number;
  allIn: boolean;
  passed: Set<string>;
  minimum: number;
}

interface ForAllState {
  eligibleIds: string[];
  answers: Map<string, string>;
  judged: Set<string>;
}

interface AppealState {
  judgmentId: number;
  requesterId: string;
  targetId: string;
  kind: 'for' | 'against';
  eligibleVoterIds: string[];
  votes: Map<string, boolean>;
}

interface PausedState {
  phase: Phase;
  timerName: string | null;
  timerMs: number | null;
  roundMs: number | null;
}

export type BuzzResult = 'accepted' | 'falseStart' | 'queued' | 'ignored';

export interface GameView {
  phase: Phase;
  pausedPhase: Phase | null;
  roundIndex: number;
  round: { name: string; type: Round['type'] } | null;
  roundEndsAt: number | null;
  board: Array<{
    name: string;
    questions: Array<{ price: number; available: boolean }>;
  }>;
  chooserId: string | null;
  removedFinalThemes: number[];
  timer: { name: string; endsAt: number; durationMs: number } | null;
  current: {
    themeIndex: number;
    questionIndex: number;
    themeName: string;
    price: number;
    type: QuestionType;
    content: ContentItem[];
    answerShown: boolean;
    assignedId: string | null;
    priceRange: unknown;
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
  auction: {
    turnId: string | null;
    leaderId: string | null;
    amount: number;
    allIn: boolean;
    passedIds: string[];
    minimum: number;
    minimumNextBid: number;
  } | null;
  forAll: {
    eligibleIds: string[];
    submittedIds: string[];
    yourAnswer: string | null;
    answers: Record<string, string> | null;
    judgedIds: string[];
  } | null;
  final: {
    wagered: string[];
    yourWager: number | null;
    wagers: Record<string, number | undefined> | null;
    judged: string[];
  } | null;
  appeals: {
    judgments: Array<Pick<Judgment, 'id' | 'playerId' | 'correct' | 'delta' | 'appealed' | 'voided'>>;
    active: {
      judgmentId: number;
      requesterId: string;
      targetId: string;
      kind: 'for' | 'against';
      eligibleVoterIds: string[];
      votedIds: string[];
    } | null;
  } | null;
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
  roundTimeout?: ReturnType<typeof setTimeout>;
  finalWagers!: Map<string, number>;
  finalJudged!: Set<string>;
  removedFinalThemes!: Set<number>;
  paused!: PausedState | null;
  auction!: StakeAuction | null;
  forAll!: ForAllState | null;
  appeal!: AppealState | null;

  constructor(room: Room) {
    this.room = room;
    this.reset();
  }

  reset(): void {
    this.clearTimer();
    clearTimeout(this.roundTimeout);
    this.phase = PHASES.LOBBY;
    this.roundIndex = -1;
    this.played = new Set<string>();
    this.chooserId = null;
    this.current = null;
    this.roundEndsAt = null;
    this.finalWagers = new Map();
    this.finalJudged = new Set();
    this.removedFinalThemes = new Set();
    this.paused = null;
    this.auction = null;
    this.forAll = null;
    this.appeal = null;
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

  /** A departed answerer must not leave the next selection assigned to an empty seat. */
  ensureConnectedChooser(): void {
    const chooser = this.chooserId ? this.room.participants.get(this.chooserId) : null;
    if (chooser?.role === ROLES.PLAYER && chooser.connected) return;
    this.chooserId = [...this.activePlayers()]
      .sort((a, b) => a.score - b.score || a.joinedAt - b.joinedAt)[0]?.id ?? null;
  }

  /** A removed or reseated player no longer has an answer to judge. */
  forAllEligibleIds(): string[] {
    return this.forAll?.eligibleIds.filter((id) => this.room.participants.get(id)?.role === ROLES.PLAYER) ?? [];
  }

  /** Final theme removal always plays the first question of each unplayed theme. */
  finalThemeIndices(): number[] {
    if (this.round?.type !== 'final') return [];
    return this.round.themes.flatMap((theme, index) =>
      theme.questions[0]?.price >= 0 && !this.played.has(`${this.roundIndex}:${index}:0`) ? [index] : []);
  }

  finalEligibleIds(): string[] {
    return [...this.finalWagers.keys()].filter((id) =>
      this.room.participants.get(id)?.role === ROLES.PLAYER);
  }

  isAvailable(t: number, q: number): boolean {
    const question = this.round?.themes[t]?.questions[q];
    return !!question && (this.round.type !== 'final' || q === 0) &&
      !this.removedFinalThemes.has(t) && question.price >= 0 &&
      !this.played.has(`${this.roundIndex}:${t}:${q}`);
  }

  roundHasQuestionsLeft(): boolean {
    return !!this.round?.themes.some((theme, t) => theme.questions.some((_, q) => this.isAvailable(t, q)));
  }

  assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }

  /** Keep actual deltas so appeals and recovery use the rules in force when judging. */
  recordJudgment(playerId: string, correct: boolean, delta: number, rightDelta: number,
    wrongDelta: number, kind = 'normal'): Judgment {
    this.assert(this.current, 'No active question');
    const judgment = {
      id: this.current.judgments.length + 1,
      playerId, correct, delta, rightDelta, wrongDelta, kind,
      appealed: false, voided: false,
    };
    this.current.judgments.push(judgment);
    return judgment;
  }

  /** Recovery replays an interrupted question, so remove every score it already awarded. */
  rollbackCurrentScores(): void {
    for (const judgment of this.current?.judgments ?? []) {
      if (judgment.voided) continue;
      const player = this.room.participants.get(judgment.playerId);
      if (player) player.score -= judgment.delta;
      judgment.voided = true;
    }
    if (this.current) this.chooserId = this.current.chooserBeforeQuestion;
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

  pause(): void {
    this.assert(this.phase !== PHASES.LOBBY && this.phase !== PHASES.GAME_OVER &&
      this.phase !== PHASES.PAUSED, 'Game cannot be paused now');
    this.paused = {
      phase: this.phase,
      timerName: this.timer?.name ?? null,
      timerMs: this.timer ? Math.max(0, this.timer.endsAt - Date.now()) : null,
      roundMs: this.roundEndsAt ? Math.max(0, this.roundEndsAt - Date.now()) : null,
    };
    this.clearTimer();
    clearTimeout(this.roundTimeout);
    clearTimeout(this.buzzWindowHandle);
    this.roundEndsAt = null;
    this.phase = PHASES.PAUSED;
  }

  resume(): void {
    this.assert(this.phase === PHASES.PAUSED && this.paused, 'Game is not paused');
    const saved = this.paused;
    this.paused = null;
    this.phase = saved.phase;
    this.roundEndsAt = saved.roundMs == null ? null : Date.now() + saved.roundMs;
    this.scheduleRoundEnd();
    if (saved.timerName && saved.timerMs != null) {
      const onExpire = saved.timerName === 'reading' ? () =>
        this.current?.type === 'forAll' ? this.openForAllAnswers() : this.openBuzzer()
        : saved.timerName === 'stake' ? () => this.passStake(this.auctionTurnId())
        : saved.timerName === 'forAll' ? () => this.closeForAllAnswers()
        : saved.timerName === 'buzzer' ? () => this.revealAnswer()
          : saved.timerName === 'final' ? () => this.closeFinal()
            : saved.timerName === 'appeal' ? () => this.resolveAppeal() : undefined;
      this.startTimer(saved.timerName, Math.max(0.001, saved.timerMs / 1000), onExpire);
    }
    if (this.phase === PHASES.BUZZER_OPEN && this.buzzer.pending.length) {
      const pool = this.buzzer.pending;
      this.buzzer.pending = [];
      this.grantPendingBuzz(pool);
    }
  }

  /* ---------------------------------------------------------------- flow */

  start(): void {
    this.assert(this.phase === PHASES.LOBBY || this.phase === PHASES.GAME_OVER, 'Stop the current game before starting again');
    this.assert(this.pack, 'Load a pack first');
    this.assert(this.pack.rounds.length > 0, 'This pack has no rounds');
    this.assert(this.room.players().length > 0, 'At least one player is required');
    this.assert(this.room.host()?.connected, 'A connected host is required before starting');
    if (this.settings.gameMode === 'classic') {
      this.assert(!this.pack.rounds.some((round) =>
        round.themes.some((theme) => theme.questions.some((q) => !['simple', 'noRisk', 'stake', 'secret', 'secretPublicPrice', 'secretNoQuestion', 'forAll'].includes(q.type)))),
      'This pack contains special or final questions; choose Simple game mode');
    }
    this.reset();
    for (const p of this.room.players()) p.score = 0;
    this.enterRound(0);
  }

  stop(): void {
    this.reset();
  }

  enterRound(index: number): void {
    this.clearTimer();
    clearTimeout(this.roundTimeout);
    this.roundIndex = index;
    this.current = null;
    this.auction = null;
    this.forAll = null;
    this.appeal = null;
    this.resetBuzzer();
    this.removedFinalThemes = new Set();
    const finalThemes = this.finalThemeIndices().length;
    this.phase = this.round?.type === 'final' && finalThemes > 1 ? PHASES.FINAL_THEMES : PHASES.BOARD;
    this.roundEndsAt = this.settings.timeOfRound > 0 ? Date.now() + this.settings.timeOfRound * 1000 : null;
    this.scheduleRoundEnd();

    const players = this.room.players();
    if (index === 0 || !players.length) {
      this.chooserId = players.length ? players[Math.floor(Math.random() * players.length)].id : null;
    } else {
      this.chooserId = [...players].sort((a, b) => a.score - b.score)[0].id;
    }
    if (this.phase === PHASES.BOARD) this.startChoosingTimer();
  }

  removeFinalTheme(actorId: string | null, actorIsModerator: boolean, themeIndex: number): void {
    this.assert(this.phase === PHASES.FINAL_THEMES, 'Final themes are not being eliminated');
    this.assert(actorIsModerator || actorId === this.chooserId, 'It is not your turn to choose');
    this.assert(Number.isInteger(themeIndex) && this.finalThemeIndices().includes(themeIndex) &&
      !this.removedFinalThemes.has(themeIndex), 'That theme is not available');
    const remaining = this.finalThemeIndices().filter((i) => !this.removedFinalThemes.has(i)).length;
    this.assert(remaining > 1, 'The final theme is already selected');
    this.removedFinalThemes.add(themeIndex);
    if (remaining === 2) {
      this.phase = PHASES.BOARD;
      this.startChoosingTimer();
    }
  }

  scheduleRoundEnd(): void {
    clearTimeout(this.roundTimeout);
    if (!this.roundEndsAt) return;
    this.roundTimeout = setTimeout(() => {
      if (this.phase === PHASES.BOARD || this.phase === PHASES.FINAL_THEMES) {
        this.clearTimer();
        this.phase = PHASES.ROUND_END;
        this.room.emitEvent({ type: 'roundEnd', roundIndex: this.roundIndex, outOfTime: true });
        this.room.changed();
      }
    }, Math.max(0, this.roundEndsAt - Date.now()));
  }

  startChoosingTimer(): void {
    // Informational only: a human host can always pick on behalf of the chooser.
    this.ensureConnectedChooser();
    this.startTimer('choosing', this.settings.timeForChoosingQuestion);
  }

  nextRound(): void {
    this.assert(this.phase === PHASES.ROUND_END, 'Finish the current round first');
    this.assert(this.pack, 'No pack loaded');
    const next = this.pack.rounds[this.roundIndex + 1];
    if (next) this.enterRound(this.roundIndex + 1);
    else this.finish();
  }

  finish(): void {
    this.clearTimer();
    clearTimeout(this.roundTimeout);
    this.current = null;
    this.auction = null;
    this.forAll = null;
    this.appeal = null;
    this.phase = PHASES.GAME_OVER;
  }

  selectQuestion(actorId: string | null, actorIsModerator: boolean, themeIndex: number, questionIndex: number): void {
    this.assert(this.phase === PHASES.BOARD, 'You cannot choose a question right now');
    if (this.roundEndsAt && Date.now() >= this.roundEndsAt) {
      this.clearTimer();
      this.phase = PHASES.ROUND_END;
      this.room.changed();
      throw new Error('The round has ended');
    }
    this.assert(actorIsModerator || actorId === this.chooserId, 'It is not your turn to choose');
    this.assert(this.isAvailable(themeIndex, questionIndex), 'This question is not available');
    const round = this.round;
    this.assert(round, 'No active round');
    if (round.type === 'final') this.assert(questionIndex === 0, 'Only the first question of a final theme is played');

    const theme = round.themes[themeIndex];
    const question = theme.questions[questionIndex];
    // Special and final questions need their own turn and scoring rules.
    this.assert(round.type === 'final' || this.settings.gameMode === 'simple' ||
      ['simple', 'noRisk', 'stake', 'secret', 'secretPublicPrice', 'secretNoQuestion', 'forAll'].includes(question.type),
      'This question type is not supported yet; use Simple game mode');
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
      assignedId: null,
      chooserBeforeQuestion: this.chooserId,
      judgments: [],
    };
    if (round.type === 'final') {
      this.finalWagers = new Map();
      this.finalJudged = new Set();
      this.phase = PHASES.FINAL_WAGER;
      return;
    }
    if (this.current.type === 'stake') {
      this.startStakeAuction();
      return;
    }
    if (this.current.type === 'forAll') {
      // Every connected player at selection gets a private answer slot.
      this.forAll = { eligibleIds: this.activePlayers().map((p) => p.id), answers: new Map(), judged: new Set() };
      this.phase = PHASES.READING;
      this.startTimer('reading', this.estimateReadingSeconds(question), () => this.openForAllAnswers());
      return;
    }
    if (this.isAssignedQuestion()) {
      this.phase = PHASES.SPECIAL_SETUP;
      this.room.emitEvent({ type: 'specialSetup', themeIndex, questionIndex });
      return;
    }
    this.phase = PHASES.READING;
    this.room.emitEvent({ type: 'questionSelected', themeIndex, questionIndex, price: question.price });

    if (!this.settings.falseStart) {
      const totalSeconds = this.estimateReadingSeconds(question) + this.settings.timeForThinkingOnQuestion;
      this.openBuzzer(totalSeconds);
    } else {
      this.startTimer('reading', this.estimateReadingSeconds(question), () => this.openBuzzer());
    }
  }

  isAssignedQuestion(): boolean {
    return ['stake', 'secret', 'secretPublicPrice', 'secretNoQuestion'].includes(this.current?.type ?? '');
  }

  /** The chooser bids first, then players follow ascending-score order. */
  startStakeAuction(): void {
    this.assert(this.current, 'No active question');
    const players = [...this.activePlayers()].sort((a, b) => a.score - b.score || a.joinedAt - b.joinedAt);
    this.assert(players.length > 0, 'No connected players can bid');
    const chooserIndex = Math.max(0, players.findIndex((p) => p.id === this.chooserId));
    const order = [...players.slice(chooserIndex), ...players.slice(0, chooserIndex)].map((p) => p.id);
    this.auction = {
      order, turnIndex: -1, leaderId: null, amount: 0, allIn: false,
      passed: new Set(), minimum: this.current.question.price,
    };
    this.phase = PHASES.STAKE_AUCTION;
    this.advanceStakeAuction();
  }

  auctionTurnId(): string | null {
    return this.auction?.order[this.auction.turnIndex] ?? null;
  }

  /** Skips passed/disconnected players and the current leader; their prior bid still stands. */
  advanceStakeAuction(): void {
    const auction = this.auction;
    this.assert(auction && this.phase === PHASES.STAKE_AUCTION, 'No stake auction is active');
    for (let offset = 1; offset <= auction.order.length; offset++) {
      const index = (auction.turnIndex + offset) % auction.order.length;
      const id = auction.order[index];
      const player = this.room.participants.get(id);
      if (id === auction.leaderId || auction.passed.has(id) ||
          player?.role !== ROLES.PLAYER || !player.connected) continue;
      auction.turnIndex = index;
      this.startTimer('stake', this.settings.timeForMakingStake, () => this.passStake(id));
      return;
    }
    this.finishStakeAuction();
  }

  bidStake(playerId: string, amount: number, allIn = false): void {
    const auction = this.auction;
    this.assert(this.phase === PHASES.STAKE_AUCTION && auction, 'No stake auction is active');
    this.assert(playerId === this.auctionTurnId(), 'It is not your turn to bid');
    const player = this.room.participants.get(playerId);
    this.assert(player?.role === ROLES.PLAYER && player.connected, 'Only a connected player may bid');
    this.assert(typeof allIn === 'boolean' && Number.isInteger(amount), 'Bid must be a whole number');
    this.assert(amount >= auction.minimum && amount > auction.amount, `Bid must exceed ${auction.amount} and reach ${auction.minimum}`);
    if (allIn) {
      this.assert(amount === player.score, 'All-in bid must equal your score');
    } else {
      this.assert(!auction.allIn, 'Only a higher all-in bid can beat an all-in');
      this.assert(amount <= Math.max(auction.minimum, player.score), 'Bid exceeds your available stake');
    }
    auction.leaderId = playerId;
    auction.amount = amount;
    auction.allIn = allIn;
    this.room.emitEvent({ type: 'stakeBid', playerId, amount, allIn });
    this.advanceStakeAuction();
  }

  passStake(playerId: string | null): void {
    const auction = this.auction;
    this.assert(this.phase === PHASES.STAKE_AUCTION && auction, 'No stake auction is active');
    this.assert(playerId && playerId === this.auctionTurnId(), 'It is not your turn to bid');
    auction.passed.add(playerId);
    this.room.emitEvent({ type: 'stakePass', playerId });
    this.advanceStakeAuction();
  }

  finishStakeAuction(): void {
    const auction = this.auction;
    this.assert(auction, 'No stake auction is active');
    this.clearTimer();
    this.auction = null;
    this.assert(this.current, 'No active question');
    const winner = auction.leaderId ? this.room.participants.get(auction.leaderId) : null;
    if (winner?.role !== ROLES.PLAYER || !winner.connected) {
      // Everyone passed or the high bidder left: never assign an offline answerer.
      this.phase = PHASES.REVEAL;
      this.current.answerShown = true;
      return;
    }
    this.current.price = auction.amount;
    this.current.assignedId = auction.leaderId;
    this.phase = PHASES.READING;
    this.room.emitEvent({ type: 'stakeWon', playerId: auction.leaderId, amount: auction.amount });
    this.startTimer('reading', this.estimateReadingSeconds(this.current.question), () => this.openBuzzer());
  }

  openForAllAnswers(): void {
    this.assert(this.phase === PHASES.READING && this.current?.type === 'forAll' && this.forAll,
      'No for-all question is being read');
    this.phase = PHASES.FOR_ALL_ANSWERING;
    this.startTimer('forAll', this.settings.timeForThinkingOnSpecial, () => this.closeForAllAnswers());
  }

  submitForAllAnswer(playerId: string, answer: string): void {
    this.assert(this.phase === PHASES.FOR_ALL_ANSWERING && this.forAll, 'Answers are closed');
    const forAll = this.forAll;
    this.assert(this.forAllEligibleIds().includes(playerId) &&
      this.room.participants.get(playerId)?.connected, 'You cannot answer this question');
    this.assert(!forAll.answers.has(playerId), 'Answer already submitted');
    this.assert(typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 350,
      'Answer must be 1–350 characters');
    forAll.answers.set(playerId, answer.trim());
    // Disconnected players retain an answer slot, but cannot hold everyone else at the timer.
    if (this.forAllEligibleIds().every((id) =>
      !this.room.participants.get(id)?.connected || forAll.answers.has(id))) {
      this.closeForAllAnswers();
    }
  }

  closeForAllAnswers(): void {
    this.assert(this.phase === PHASES.FOR_ALL_ANSWERING && this.forAll, 'Answers are closed');
    this.clearTimer();
    this.phase = PHASES.FOR_ALL_JUDGE;
    if (!this.forAllEligibleIds().length) this.revealAnswer();
  }

  judgeForAll(playerId: string, correct: boolean): void {
    this.assert(this.phase === PHASES.FOR_ALL_JUDGE && this.forAll, 'For-all answers are not being judged');
    this.assert(this.current, 'No active question');
    const forAll = this.forAll;
    const current = this.current;
    this.assert(typeof correct === 'boolean', 'Verdict must be true or false');
    this.assert(this.forAllEligibleIds().includes(playerId) && !forAll.judged.has(playerId),
      'Player already judged or not in this question');
    const player = this.room.participants.get(playerId);
    this.assert(player, 'Unknown player');
    const hasAnswer = forAll.answers.has(playerId);
    const accepted = correct && hasAnswer;
    const delta = accepted ? current.price : this.settings.ignoreWrong ? 0 : -current.price;
    player.score += delta;
    this.recordJudgment(playerId, accepted, delta, current.price,
      this.settings.ignoreWrong ? 0 : -current.price, 'forAll');
    forAll.judged.add(playerId);
    this.room.emitEvent({ type: 'answerJudged', playerId, correct: accepted, delta });
    if (this.forAllEligibleIds().every((id) => forAll.judged.has(id))) this.revealAnswer();
  }

  configureSpecial(playerId: string, price: number): void {
    this.assert(this.phase === PHASES.SPECIAL_SETUP, 'No special question is awaiting setup');
    this.assert(this.current, 'No active question');
    const current = this.current;
    const player = this.room.participants.get(playerId);
    this.assert(player?.role === ROLES.PLAYER && player.connected, 'Choose a connected player');
    const { type, question } = current;
    const range = question.typeParams?.price;
    // A secret without a question is a gift of the pack's fixed value.
    const gift = type === 'secretNoQuestion';
    const minimum = gift ? question.price : range?.minimum ?? question.price;
    const maximum = gift ? question.price : range?.maximum ?? Math.max(question.price, player.score);
    const step = range?.step || 1;
    this.assert(Number.isInteger(price) && price >= minimum && price <= maximum &&
      (price - minimum) % step === 0, `Value must be ${minimum}–${maximum} in steps of ${step}`);
    if (type.startsWith('secret') && question.typeParams?.selectionMode === 'exceptCurrent') {
      this.assert(playerId !== this.chooserId, 'Choose another player for this secret question');
    }
    current.price = price;
    current.assignedId = playerId;
    if (gift) {
      player.score += price;
      this.recordJudgment(playerId, true, price, price, 0, 'gift');
      current.answerShown = true;
      this.phase = PHASES.REVEAL;
      this.room.emitEvent({ type: 'giftAwarded', playerId, price });
      return;
    }
    this.phase = PHASES.READING;
    this.startTimer('reading', this.estimateReadingSeconds(question), () => this.openBuzzer());
  }

  setFinalWager(playerId: string, amount: number): void {
    this.assert(this.phase === PHASES.FINAL_WAGER, 'Final wagers are closed');
    const player = this.room.participants.get(playerId);
    this.assert(player?.role === ROLES.PLAYER, 'Only players may wager');
    this.assert(Number.isInteger(amount) && amount >= 0 && amount <= Math.max(0, player.score),
      'Wager must be between zero and your current positive score');
    this.finalWagers.set(playerId, amount);
  }

  openFinal(): void {
    this.assert(this.phase === PHASES.FINAL_WAGER, 'Final question is not ready');
    this.assert(this.activePlayers().every((p) => this.finalWagers.has(p.id)), 'Wait for every connected player to wager');
    // A disconnected player cannot block the final; their wager defaults to zero.
    for (const player of this.room.players()) {
      if (!this.finalWagers.has(player.id)) this.finalWagers.set(player.id, 0);
    }
    this.phase = PHASES.FINAL_QUESTION;
    this.startTimer('final', this.settings.timeForFinalThinking, () => this.closeFinal());
  }

  closeFinal(): void {
    this.assert(this.phase === PHASES.FINAL_QUESTION, 'Final question is not open');
    this.clearTimer();
    this.phase = PHASES.FINAL_JUDGE;
    if (!this.finalEligibleIds().length) this.revealAnswer();
  }

  judgeFinal(playerId: string, correct: boolean): void {
    this.assert(this.phase === PHASES.FINAL_JUDGE, 'Final answers are not being judged');
    this.assert(typeof correct === 'boolean', 'Verdict must be true or false');
    this.assert(this.finalEligibleIds().includes(playerId) && !this.finalJudged.has(playerId),
      'Player already judged or not in final');
    const player = this.room.participants.get(playerId);
    this.assert(player, 'Unknown player');
    const amount = this.finalWagers.get(playerId);
    this.assert(amount !== undefined, 'Player has no final wager');
    const delta = correct ? amount : -amount;
    player.score += delta;
    this.recordJudgment(playerId, correct, delta, amount, -amount, 'final');
    this.finalJudged.add(playerId);
    if (this.finalEligibleIds().every((id) => this.finalJudged.has(id))) this.revealAnswer();
  }

  /** Estimates how long the question takes to present, using SIGame's ReadingSpeed. */
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

  /** Resolve queued presses using the mode active when they were collected. */
  grantPendingBuzz(pool: PendingBuzz[]): void {
    if (!pool.length) return;
    if (this.settings.buttonPressMode === 'randomWithinInterval') {
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      this.grantAnswer(chosen.playerId, {
        mode: 'random',
        reactionMs: Math.max(0, chosen.serverAt - (this.buzzer.openedAt ?? chosen.serverAt)),
      });
      return;
    }
    pool.sort((a, b) => a.effectiveAt - b.effectiveAt || a.serverAt - b.serverAt);
    const chosen = pool[0];
    this.grantAnswer(chosen.playerId, {
      mode: 'clientTimestamp',
      reactionMs: Math.max(0, Math.round(chosen.effectiveAt - (this.buzzer.openedAt ?? chosen.effectiveAt))),
      transitMs: chosen.transitMs,
      contenders: pool.length,
    });
  }

  openBuzzer(overrideSeconds?: number): void {
    this.assert(this.phase === PHASES.READING || this.phase === PHASES.ANSWERING, 'Buttons cannot be opened now');
    this.assert(this.current?.type !== 'forAll', 'For-all questions do not use buttons');
    if (this.isAssignedQuestion()) {
      this.assert(this.current?.assignedId, 'No player is assigned');
      this.grantAnswer(this.current.assignedId);
      return;
    }
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
    this.startTimer('buzzer', seconds, () => {
      // A press inside the countdown still counts when its random window outlasts the countdown.
      if (!this.buzzer.pending.length) return this.revealAnswer();
      clearTimeout(this.buzzWindowHandle);
      const pool = this.buzzer.pending;
      this.buzzer.pending = [];
      this.grantPendingBuzz(pool);
      this.buzzer.remainingMs = 1000;
    });
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
      if (this.isAssignedQuestion()) return { result: 'ignored' };
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
            this.grantPendingBuzz(pool);
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
            this.grantPendingBuzz(pool);
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
    // The host must make the verdict; an elapsed countdown must not silently decide it.
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
      this.recordJudgment(this.buzzer.winnerId, true, price, price,
        this.settings.ignoreWrong || this.current.type === 'noRisk' ? 0 : -price);
      this.chooserId = this.buzzer.winnerId;
      this.room.emitEvent({ type: 'answerJudged', playerId: this.buzzer.winnerId, correct: true, delta: price });
      this.revealAnswer();
      return;
    }

    // Sponsored/no-risk questions do not penalize a wrong answer.
    const delta = this.settings.ignoreWrong || this.current.type === 'noRisk' ? 0 : -price;
    if (player) player.score += delta;
    this.recordJudgment(this.buzzer.winnerId, false, delta, price, delta);
    this.buzzer.attempted.add(this.buzzer.winnerId);
    this.room.emitEvent({ type: 'answerJudged', playerId: this.buzzer.winnerId, correct: false, delta });

    const someoneLeft = this.activePlayers().some((p) => !this.buzzer.attempted.has(p.id));
    if (someoneLeft && !this.isAssignedQuestion()) this.openBuzzer();
    else this.revealAnswer();
  }

  revealAnswer(): void {
    this.assert((QUESTION_PHASES.has(this.phase) && this.round?.type !== 'final') ||
      (this.phase === PHASES.FINAL_JUDGE && this.finalEligibleIds().every((id) => this.finalJudged.has(id))),
      'Judge every final answer before revealing');
    this.assert(this.current?.type !== 'forAll' ||
      (this.phase === PHASES.FOR_ALL_JUDGE && this.forAllEligibleIds().every((id) => this.forAll?.judged.has(id))),
    'Judge every for-all answer before revealing');
    this.assert(this.current, 'No active question');
    this.clearTimer();
    clearTimeout(this.buzzWindowHandle);
    this.phase = PHASES.REVEAL;
    this.current.answerShown = true;
  }

  /** An answerer may challenge a rejection; another player may challenge an acceptance. */
  requestAppeal(requesterId: string, judgmentId: number): void {
    this.assert(this.phase === PHASES.REVEAL && this.current?.answerShown, 'Appeals open after the answer is revealed');
    this.assert(this.settings.useApellations, 'Appeals are disabled');
    const requester = this.room.participants.get(requesterId);
    this.assert(requester?.role === ROLES.PLAYER && requester.connected, 'Only connected players may appeal');
    const judgment = this.current.judgments.find((item) => item.id === judgmentId);
    this.assert(judgment && !judgment.appealed && !judgment.voided && judgment.kind !== 'gift',
      'That verdict cannot be appealed');
    this.assert(this.room.participants.get(judgment.playerId)?.role === ROLES.PLAYER,
      'The answerer is no longer a player');
    const kind = judgment.correct ? 'against' : 'for';
    if (kind === 'for') {
      this.assert(requesterId === judgment.playerId, 'Only the answerer may appeal a rejection');
      this.assert(judgment.kind !== 'forAll' || this.forAll?.answers.has(requesterId),
        'A blank answer cannot be appealed');
    } else {
      this.assert(requesterId !== judgment.playerId, 'Another player must challenge an acceptance');
      this.assert(this.activePlayers().length > 3, 'At least four connected players are required');
    }

    const eligibleVoterIds = this.activePlayers().map((p) => p.id)
      .filter((id) => id !== judgment.playerId && (kind === 'for' || id !== requesterId));
    this.appeal = { judgmentId, requesterId, targetId: judgment.playerId, kind,
      eligibleVoterIds, votes: new Map() };
    this.phase = PHASES.APPEAL_VOTE;
    this.room.emitEvent({ type: 'appealStarted', judgmentId, requesterId,
      targetId: judgment.playerId, kind });
    if (eligibleVoterIds.length) {
      this.startTimer('appeal', this.settings.timeForShowmanDecisions || 30, () => this.resolveAppeal());
    } else {
      this.resolveAppeal();
    }
  }

  voteAppeal(playerId: string, support: boolean): void {
    this.assert(this.phase === PHASES.APPEAL_VOTE && this.appeal, 'No appeal vote is open');
    const appeal = this.appeal;
    this.assert(typeof support === 'boolean', 'Vote must be true or false');
    this.assert(appeal.eligibleVoterIds.includes(playerId) &&
      this.room.participants.get(playerId)?.connected, 'You cannot vote on this appeal');
    this.assert(!appeal.votes.has(playerId), 'You already voted');
    appeal.votes.set(playerId, support);
    if (appeal.eligibleVoterIds.every((id) => appeal.votes.has(id) ||
      !this.room.participants.get(id)?.connected)) this.resolveAppeal();
  }

  resolveAppeal(): void {
    this.assert(this.phase === PHASES.APPEAL_VOTE && this.appeal, 'No appeal vote is open');
    this.assert(this.current, 'No active question');
    this.clearTimer();
    const appeal = this.appeal;
    const current = this.current;
    const judgment = current.judgments.find((item) => item.id === appeal.judgmentId);
    this.assert(judgment, 'Appealed verdict is missing');
    // The answerer supports their verdict; the host supports the original verdict.
    // A challenger of an accepted answer contributes one fixed vote against it.
    let support = 1;
    let oppose = appeal.kind === 'against' ? 2 : 1;
    for (const vote of appeal.votes.values()) {
      if (vote) support += 1;
      else oppose += 1;
    }
    const accepted = support > oppose;
    judgment.appealed = true;
    if (accepted) {
      const correctedDelta = judgment.correct ? judgment.wrongDelta : judgment.rightDelta;
      const target = this.room.participants.get(judgment.playerId);
      if (target) target.score += correctedDelta - judgment.delta;
      judgment.correct = !judgment.correct;
      judgment.delta = correctedDelta;
      if (judgment.kind === 'normal') {
        if (appeal.kind === 'for') {
          // A newly accepted early answer invalidates all later attempts on this question.
          for (const later of current.judgments.filter((item) => item.id > judgment.id && !item.voided)) {
            const player = this.room.participants.get(later.playerId);
            if (player) player.score -= later.delta;
            later.voided = true;
          }
          this.chooserId = judgment.playerId;
        } else {
          this.chooserId = current.chooserBeforeQuestion;
        }
        this.ensureConnectedChooser();
      }
    }
    this.appeal = null;
    this.phase = PHASES.REVEAL;
    this.room.emitEvent({ type: 'appealResolved', judgmentId: judgment.id,
      targetId: judgment.playerId, kind: appeal.kind, accepted, support, oppose });
  }

  /** Leaves the current question (or skips it) and returns to the board / ends the round. */
  next(): void {
    if (this.phase === PHASES.ROUND_END) return this.nextRound();
    if (this.round?.type === 'final' && this.phase === PHASES.REVEAL) {
      const remaining = this.finalThemeIndices();
      if (!this.settings.playAllQuestionsInFinalRound || !remaining.length ||
          (this.roundEndsAt && Date.now() >= this.roundEndsAt)) return this.finish();
      // Each final theme contributes its first question; earlier eliminations reset.
      this.current = null;
      this.appeal = null;
      this.removedFinalThemes.clear();
      if (remaining.length > 1) {
        this.phase = PHASES.FINAL_THEMES;
      } else {
        this.phase = PHASES.BOARD;
        this.selectQuestion(this.chooserId, true, remaining[0], 0);
      }
      return;
    }
    this.assert(QUESTION_PHASES.has(this.phase) || this.phase === PHASES.SPECIAL_SETUP ||
      this.phase === PHASES.STAKE_AUCTION, 'Nothing to continue');
    this.clearTimer();
    this.current = null;
    this.appeal = null;
    this.auction = null;
    this.forAll = null;
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
    const forAll = this.forAll;
    // A player who owns the room may moderate, but must never receive an early answer.
    const showAnswer = viewer?.role === ROLES.HOST || (c?.answerShown ?? false);

    return {
      phase: this.phase,
      pausedPhase: this.paused?.phase ?? null,
      roundIndex: this.roundIndex,
      round: round ? { name: round.name, type: round.type } : null,
      roundEndsAt: this.roundEndsAt,
      board:
        round?.themes.map((theme, t) => ({
          name: theme.name,
          questions: theme.questions.map((q, i) => ({ price: q.price, available: this.isAvailable(t, i) })),
        })) ?? [],
      removedFinalThemes: [...this.removedFinalThemes],
      chooserId: this.chooserId,
      timer: this.timer && { name: this.timer.name, endsAt: this.timer.endsAt, durationMs: this.timer.durationMs },
      current: c && {
        themeIndex: c.themeIndex,
        questionIndex: c.questionIndex,
        themeName: c.type === 'secretNoQuestion' ? 'Gift' : c.themeName,
        price: c.price,
        type: c.type,
        content: c.type === 'secretNoQuestion' ||
          ([PHASES.SPECIAL_SETUP, PHASES.STAKE_AUCTION, PHASES.FINAL_WAGER] as Phase[]).includes(this.phase) ||
          (this.phase === PHASES.PAUSED &&
            ([PHASES.SPECIAL_SETUP, PHASES.STAKE_AUCTION, PHASES.FINAL_WAGER] as Phase[]).includes(this.paused?.phase ?? PHASES.PAUSED))
          ? [] : c.question.content,
        assignedId: c.assignedId,
        priceRange: this.phase === PHASES.SPECIAL_SETUP ? c.question.typeParams?.price ?? null : null,
        answerShown: c.answerShown,
        right: showAnswer && c.type !== 'secretNoQuestion' ? c.question.right : null,
        wrong: viewer?.role === ROLES.HOST ? c.question.wrong : null,
        answerContent: showAnswer && c.type !== 'secretNoQuestion' ? c.question.answerContent : null,
        comments: showAnswer && c.type !== 'secretNoQuestion' ? c.question.info.comments : null,
        sources: showAnswer && c.type !== 'secretNoQuestion' && this.settings.displaySources ? c.question.info.sources : null,
      },
      buzzer: {
        winnerId: this.buzzer.winnerId,
        winnerInfo: this.buzzer.winnerInfo,
        attempted: [...this.buzzer.attempted],
        blockedUntil: viewer ? (this.buzzer.blockedUntil.get(viewer.id) ?? null) : null,
        blockedPlayers: [...this.buzzer.blockedUntil.entries()]
          .filter(([, until]) => until > Date.now())
          .map(([id, until]) => ({ id, until })),
      },
      auction: this.auction ? {
        turnId: this.auctionTurnId(),
        leaderId: this.auction.leaderId,
        amount: this.auction.amount,
        allIn: this.auction.allIn,
        passedIds: [...this.auction.passed],
        minimum: this.auction.minimum,
        minimumNextBid: Math.max(this.auction.minimum, this.auction.amount + 1),
      } : null,
      forAll: forAll ? {
        eligibleIds: this.forAllEligibleIds(),
        submittedIds: [...forAll.answers.keys()],
        yourAnswer: viewer ? forAll.answers.get(viewer.id) ?? null : null,
        // A recovered player moderator needs submitted answers to judge, but never the key.
        answers: canModerate && this.phase === PHASES.FOR_ALL_JUDGE
          ? Object.fromEntries(this.forAllEligibleIds().map((id) => [id, forAll.answers.get(id) ?? ''])) : null,
        judgedIds: [...forAll.judged],
      } : null,
      final: this.round?.type === 'final' ? {
        wagered: [...this.finalWagers.keys()],
        yourWager: viewer ? this.finalWagers.get(viewer.id) ?? null : null,
        wagers: canModerate && this.phase === PHASES.FINAL_JUDGE
          ? Object.fromEntries(this.finalEligibleIds().map((id) => [id, this.finalWagers.get(id)])) : null,
        judged: [...this.finalJudged],
      } : null,
      // Verdicts are only public with the answer; votes stay private until resolution.
      appeals: c?.answerShown ? {
        judgments: c.judgments.filter((item) => item.kind !== 'gift').map((item) => ({
          id: item.id, playerId: item.playerId, correct: item.correct, delta: item.delta,
          appealed: item.appealed, voided: item.voided,
        })),
        active: this.appeal && {
          judgmentId: this.appeal.judgmentId,
          requesterId: this.appeal.requesterId,
          targetId: this.appeal.targetId,
          kind: this.appeal.kind,
          eligibleVoterIds: this.appeal.eligibleVoterIds,
          votedIds: [...this.appeal.votes.keys()],
        },
      } : null,
    };
  }
}

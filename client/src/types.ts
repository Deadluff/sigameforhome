export interface Participant {
  id: string;
  name: string;
  role: 'host' | 'player' | 'spectator' | 'pending';
  score: number;
  connected: boolean;
  displayOnly: boolean;
  isOwner: boolean;
}

export interface ContentItem {
  type: 'text' | 'say' | 'image' | 'audio' | 'video' | 'html';
  value: string;
  url: string | null;
  missing?: boolean;
}

export interface RoomState {
  serverTime: number;
  you: (Pick<Participant, 'id' | 'name' | 'role'> & {
    isOwner: boolean;
    canModerate: boolean;
    canManage: boolean;
  }) | null;
  participants: Participant[];
  settings: {
    gameMode: string;
    falseStart: boolean;
    ignoreWrong: boolean;
    playAllQuestionsInFinalRound: boolean;
    useApellations: boolean;
    timeForBlockingButton: number;
    readingSpeed: number;
    timeForThinkingOnQuestion: number;
    timeForPrintingAnswer: number;
    timeForMakingStake: number;
    timeForThinkingOnSpecial: number;
    timeForFinalThinking: number;
    timeOfRound: number;
    buzzSyncMode: 'server' | 'clientTimestamp';
    buzzSyncWindowMs: number;
    [key: string]: string | number | boolean;
  };
  pack: {
    name: string;
    stats: { questions: number };
    rounds: { name: string }[];
  } | null;
  game: {
    phase: string;
    pausedPhase: string | null;
    roundIndex: number;
    round: { name: string; type: string } | null;
    chooserId: string | null;
    removedFinalThemes: number[];
    board: { name: string; questions: { price: number; available: boolean }[] }[];
    timer: { name: string; endsAt: number; durationMs: number } | null;
    current: {
      themeIndex: number;
      questionIndex: number;
      themeName: string;
      price: number;
      type: string;
      assignedId: string | null;
      content: ContentItem[];
      priceRange: { minimum: number; maximum: number; step: number } | null;
      answerShown: boolean;
      right: string[] | null;
      answerContent: ContentItem[] | null;
      comments: string | null;
    } | null;
    buzzer: {
      winnerId: string | null;
      winnerInfo: { mode: 'server' | 'clientTimestamp' | 'random'; reactionMs: number; transitMs?: number; contenders?: number } | null;
      attempted: string[];
      blockedUntil: number | null;
      blockedPlayers: { id: string; until: number }[];
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
      wagers: Record<string, number> | null;
      judged: string[];
    } | null;
    appeals: {
      judgments: { id: number; playerId: string; correct: boolean; delta: number; appealed: boolean; voided: boolean }[];
      active: {
        judgmentId: number;
        requesterId: string;
        targetId: string;
        kind: 'for' | 'against';
        votedIds: string[];
        eligibleVoterIds: string[];
      } | null;
    } | null;
  };
}

export interface PackListItem {
  file: string;
  name: string;
  rounds?: number;
  size: number;
}

export interface Ack {
  ok: boolean;
  error?: string;
  packs?: PackListItem[];
}

export type JoinAck = { ok: true; token: string } | { ok: false; error: string };

export type NoPayloadCommand =
  | 'packs:list' | 'game:start' | 'game:stop' | 'game:pause' | 'game:resume'
  | 'game:openFinal' | 'game:closeFinal' | 'game:openBuzzer'
  | 'game:reveal' | 'game:next' | 'game:prevRound' | 'game:nextRound' | 'game:stakePass' | 'game:closeForAll'
  | 'game:appealClose';

export interface CommandPayloads {
  'role:choose': { role: 'host' | 'player' };
  'role:set': { targetId: string; role: 'host' | 'spectator' };
  'score:adjust': { targetId: string; delta: number };
  'packs:load': { file: string };
  'settings:update': Partial<RoomState['settings']>;
  'steam:download': { link: string };
  'game:select': { themeIndex: number; questionIndex: number };
  'game:removeFinalTheme': { themeIndex: number };
  'game:configureSpecial': { playerId: string; price: number };
  'game:finalWager': { amount: number };
  'game:judgeFinal': { playerId: string; correct: boolean };
  'game:judge': { correct: boolean };
  'game:stakeBid': { amount: number; allIn: boolean };
  'game:forAllAnswer': { answer: string };
  'game:judgeForAll': { playerId: string; correct: boolean };
  'game:appealRequest': { judgmentId: number };
  'game:appealVote': { support: boolean };
}

export type CommandEvent = NoPayloadCommand | keyof CommandPayloads;

export type GameEvent =
  | { type: 'answerJudged'; correct: boolean }
  | { type: 'buzzerOpen' | 'buzzAccepted' | 'falseStart' | 'giftAwarded' | 'specialSetup' | 'questionSelected' | 'roundEnd' | 'stakeBid' | 'stakePass' | 'stakeWon' };

export interface SteamProgress {
  stage: string;
  message: string;
  percent?: number;
}

export interface ServerToClientEvents {
  'room:state': (state: RoomState) => void;
  'game:event': (event: GameEvent) => void;
  'steam:progress': (progress: SteamProgress) => void;
  'packs:changed': (change: { packs: PackListItem[] }) => void;
  'session:kicked': () => void;
}

export type ClientToServerEvents = {
  [Event in NoPayloadCommand]: (payload: Record<string, never>, ack: (result: Ack) => void) => void;
} & {
  [Event in keyof CommandPayloads]: (payload: CommandPayloads[Event], ack: (result: Ack) => void) => void;
} & {
  'session:join': (payload: { nickname: string; asSpectator?: boolean }, ack: (result: JoinAck) => void) => void;
  'session:resume': (payload: { token: string }, ack: (result: { ok: boolean; resumed?: boolean }) => void) => void;
  'game:buzz': (payload: { clientAt: number }, ack: (result: Ack) => void) => void;
  'clock:ping': (payload: Record<string, never>, ack: (result: { ok: boolean; serverTime: number }) => void) => void;
};

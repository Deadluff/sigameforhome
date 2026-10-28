/** Shared enums. Also mirrored in the client. */

export const ROLES = Object.freeze({
  /** First connection hasn't picked yet. */
  PENDING: 'pending',
  /** Game master ("Showman" in SIGame). */
  HOST: 'host',
  PLAYER: 'player',
  SPECTATOR: 'spectator',
});

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  /** Round board shown, chooser picks a question. */
  BOARD: 'board',
  /** Question content is being shown/read. Pressing now = false start. */
  READING: 'reading',
  /** Buzzers are live. */
  BUZZER_OPEN: 'buzzerOpen',
  /** A player buzzed and is answering; host judges. */
  ANSWERING: 'answering',
  /** Correct answer displayed. */
  REVEAL: 'reveal',
  ROUND_END: 'roundEnd',
  GAME_OVER: 'gameOver',
});

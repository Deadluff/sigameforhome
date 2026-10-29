/**
 * Game settings mirroring SIGame's AppSettings / TimeSettings
 * (see SI repo: src/SIGame/.../AppSettingsCore.cs & TimeSettings.cs).
 * Names are camelCased versions of the originals, defaults match SIGame's.
 *
 * Every field is described by a schema entry so the host UI can render the
 * settings form automatically and the server can validate patches.
 */

const bool = (def, label) => ({ type: 'boolean', default: def, label });
const int = (def, min, max, label) => ({ type: 'integer', default: def, min, max, label });
const oneOf = (def, values, label) => ({ type: 'enum', default: def, values, label });

export const SETTINGS_SCHEMA = Object.freeze({
  /* ---- Table ---- */
  maxPlayers: int(6, 2, 12, 'Player slots'),

  /* ---- Rules (AppSettings) ---- */
  falseStart: bool(true, 'False starts: pressing before the question is read blocks the button'),
  /** SIGame "Oral" game: host reads questions aloud, players answer aloud. */
  oral: bool(true, 'Oral game (answers spoken, host judges)'),
  /** SIGame "IgnoreWrong": wrong answers aren't penalised. */
  ignoreWrong: bool(false, 'Do not subtract points for wrong answers'),
  /** Characters per second used to estimate reading time (SIGame ReadingSpeed). */
  readingSpeed: int(20, 1, 100, 'Reading speed (characters/second)'),
  /** SIGame PartialText: question text appears gradually. */
  partialText: bool(false, 'Show question text gradually'),
  /**
   * Who-clicked-first sync mode:
   *  - 'server': first packet to reach the server wins immediately (or random within interval)
   *  - 'clientTimestamp': uses NTP-calibrated client press timestamp within a short collection window
   *    so players on slower mobile Wi-Fi aren't penalized by network latency.
   */
  buzzSyncMode: oneOf('server', ['server', 'clientTimestamp'], 'Who-clicked-first sync mode (server vs client request time)'),
  /** Collection window (ms) when buzzSyncMode === 'clientTimestamp' to gather in-flight packets. */
  buzzSyncWindowMs: int(120, 20, 500, 'Client timestamp sync collection window (ms)'),
  /** SIGame ButtonPressMode. */
  buttonPressMode: oneOf('firstWins', ['firstWins', 'randomWithinInterval'], 'Button press resolution'),
  buttonPressIntervalMs: int(100, 0, 1000, 'Random window for simultaneous presses (ms)'),
  playAllQuestionsInFinalRound: bool(false, 'Play all questions in the final round'),
  allowEveryoneToPlayHiddenStakes: bool(true, 'Everyone may play hidden stakes'),
  displaySources: bool(false, 'Show question sources'),
  useApellations: bool(true, 'Allow appeals'),
  /** SIGame GameMode: "Classic" (special questions, stakes) or "Simple" (all questions are simple). */
  gameMode: oneOf('classic', ['classic', 'simple'], 'Game mode'),

  /* ---- Timers in seconds (TimeSettings) ---- */
  timeForChoosingQuestion: int(30, 1, 300, 'Time to choose a question'),
  timeForThinkingOnQuestion: int(5, 1, 120, 'Time to press the button after reading'),
  timeForPrintingAnswer: int(25, 1, 300, 'Time to give an answer'),
  timeForGivingACat: int(30, 1, 300, 'Time to give the secret question away'),
  timeForMakingStake: int(30, 1, 300, 'Time to make a stake'),
  timeForThinkingOnSpecial: int(25, 1, 300, 'Time to think on a special question'),
  timeOfRound: int(660, 0, 7200, 'Round duration (0 = unlimited)'),
  timeForChoosingFinalTheme: int(30, 1, 300, 'Time to remove a final theme'),
  timeForFinalThinking: int(45, 1, 300, 'Final round thinking time'),
  timeForShowmanDecisions: int(30, 1, 300, 'Host decision time'),
  timeForBlockingButton: int(3, 0, 10, 'Button block after false start'),
  timeForMediaDelay: int(0, 0, 10, 'Delay before media playback'),
});

/** @returns {Record<string, any>} a fresh settings object with SIGame defaults. */
export function defaultSettings() {
  return Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([k, s]) => [k, s.default]));
}

/**
 * Validates and applies a partial settings patch.
 * Unknown keys are ignored; invalid values throw with a readable message.
 */
export function applySettingsPatch(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const schema = SETTINGS_SCHEMA[key];
    if (!schema) continue;
    switch (schema.type) {
      case 'boolean':
        if (typeof value !== 'boolean') throw new Error(`${key} must be true/false`);
        break;
      case 'integer':
        if (!Number.isInteger(value) || value < schema.min || value > schema.max) {
          throw new Error(`${key} must be an integer between ${schema.min} and ${schema.max}`);
        }
        break;
      case 'enum':
        if (!schema.values.includes(value)) throw new Error(`${key} must be one of ${schema.values.join(', ')}`);
        break;
    }
    next[key] = value;
  }
  return next;
}

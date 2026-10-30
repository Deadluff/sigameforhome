/**
 * Game settings mirroring SIGame's AppSettings / TimeSettings
 * (see SI repo: src/SIGame/.../AppSettingsCore.cs & TimeSettings.cs).
 */

export type BuzzSyncMode = 'server' | 'clientTimestamp';
export type ButtonPressMode = 'firstWins' | 'randomWithinInterval';
export type GameMode = 'classic' | 'simple';

export interface GameSettings {
  maxPlayers: number;
  falseStart: boolean;
  oral: boolean;
  ignoreWrong: boolean;
  readingSpeed: number;
  partialText: boolean;
  buzzSyncMode: BuzzSyncMode;
  buzzSyncWindowMs: number;
  buttonPressMode: ButtonPressMode;
  buttonPressIntervalMs: number;
  playAllQuestionsInFinalRound: boolean;
  displaySources: boolean;
  useApellations: boolean;
  gameMode: GameMode;
  timeForChoosingQuestion: number;
  timeForThinkingOnQuestion: number;
  timeForPrintingAnswer: number;
  timeForGivingACat: number;
  timeForMakingStake: number;
  timeForThinkingOnSpecial: number;
  timeOfRound: number;
  timeForChoosingFinalTheme: number;
  timeForFinalThinking: number;
  timeForShowmanDecisions: number;
  timeForBlockingButton: number;
  timeForMediaDelay: number;
  timeForQuestionIntro: number;
}

export interface BooleanSettingSchema {
  type: 'boolean';
  default: boolean;
  label: string;
}

export interface IntegerSettingSchema {
  type: 'integer';
  default: number;
  min: number;
  max: number;
  label: string;
}

export interface EnumSettingSchema<T extends string = string> {
  type: 'enum';
  default: T;
  values: readonly T[];
  label: string;
}

export type SettingSchemaEntry = BooleanSettingSchema | IntegerSettingSchema | EnumSettingSchema;

const bool = (def: boolean, label: string): BooleanSettingSchema => ({ type: 'boolean', default: def, label });
const int = (def: number, min: number, max: number, label: string): IntegerSettingSchema => ({
  type: 'integer',
  default: def,
  min,
  max,
  label,
});
const oneOf = <T extends string>(def: T, values: readonly T[], label: string): EnumSettingSchema<T> => ({
  type: 'enum',
  default: def,
  values,
  label,
});

export const SETTINGS_SCHEMA: Record<keyof GameSettings, SettingSchemaEntry> = Object.freeze({
  /* ---- Table ---- */
  maxPlayers: int(6, 2, 12, 'Player slots'),

  /* ---- Rules (AppSettings) ---- */
  falseStart: bool(true, 'False starts: pressing before the question is read blocks the button'),
  oral: bool(true, 'Oral game (answers spoken, host judges)'),
  ignoreWrong: bool(false, 'Do not subtract points for wrong answers'),
  readingSpeed: int(20, 1, 100, 'Reading speed (characters/second)'),
  partialText: bool(false, 'Show question text gradually'),
  buzzSyncMode: oneOf<BuzzSyncMode>(
    'server',
    ['server', 'clientTimestamp'],
    'Who-clicked-first sync mode (server vs client request time)',
  ),
  buzzSyncWindowMs: int(120, 20, 500, 'Client timestamp sync collection window (ms)'),
  buttonPressMode: oneOf<ButtonPressMode>('firstWins', ['firstWins', 'randomWithinInterval'], 'Button press resolution'),
  buttonPressIntervalMs: int(100, 0, 1000, 'Random window for simultaneous presses (ms)'),
  playAllQuestionsInFinalRound: bool(false, 'Play all questions in the final round'),
  displaySources: bool(false, 'Show question sources'),
  useApellations: bool(true, 'Allow appeals'),
  gameMode: oneOf<GameMode>('classic', ['classic', 'simple'], 'Game mode'),

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
  timeForQuestionIntro: int(2, 0, 5, 'Pick reveal: seconds the chosen cell stays lit before the question'),
});

export function defaultSettings(): GameSettings {
  return Object.fromEntries(
    Object.entries(SETTINGS_SCHEMA).map(([k, s]) => [k, s.default]),
  ) as unknown as GameSettings;
}

export function applySettingsPatch(current: GameSettings, patch: Partial<Record<string, unknown>>): GameSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const schema = SETTINGS_SCHEMA[key as keyof GameSettings];
    if (!schema) continue;
    switch (schema.type) {
      case 'boolean':
        if (typeof value !== 'boolean') throw new Error(`${key} must be true/false`);
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < schema.min || value > schema.max) {
          throw new Error(`${key} must be an integer between ${schema.min} and ${schema.max}`);
        }
        break;
      case 'enum':
        if (typeof value !== 'string' || !schema.values.includes(value)) {
          throw new Error(`${key} must be one of ${schema.values.join(', ')}`);
        }
        break;
    }
    next[key] = value;
  }
  return next as unknown as GameSettings;
}

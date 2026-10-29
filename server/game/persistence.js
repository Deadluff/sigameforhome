/** Persist the live room so a server restart keeps seats, scores, and the board. */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { loadPack } from '../packs/packManager.js';
import { PHASES } from './constants.js';

const file = config.roomStateFile;

export async function restoreRoom(room, stateFile = file) {
  let saved;
  try { saved = JSON.parse(await fsp.readFile(stateFile, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[room] State not restored: ${err.message}`);
    return;
  }
  if (saved.version !== 1) return;
  try {
    if (saved.packFile) {
      try { room.loadedPack = await loadPack(saved.packFile); }
      catch (err) {
        // A removed or broken pack should not erase independently recoverable seats and scores.
        console.warn(`[room] Pack not restored: ${err.message}`);
      }
    }
    room.settings = saved.settings;
    for (const entry of saved.participants) {
      const participant = { ...entry, connected: false, socketId: null };
      room.participants.set(participant.id, participant);
      room.tokens.set(participant.token, participant.id);
    }
    room.ownerId = saved.ownerId;
    const game = saved.game;
    if (room.loadedPack && game && game.phase !== PHASES.LOBBY) {
      room.engine.roundIndex = game.roundIndex;
      room.engine.played = new Set(game.played);
      room.engine.removedFinalThemes = new Set(game.removedFinalThemes ?? []);
      room.engine.chooserId = game.chooserId;
      room.engine.roundEndsAt = game.paused?.roundMs != null ? Date.now() + game.paused.roundMs
        : game.roundEndsAt > Date.now() ? game.roundEndsAt : null;
      const restoredPhase = game.phase === PHASES.PAUSED ? game.paused?.phase : game.phase;
      // Replay an interrupted question from the board; scores and prior questions remain.
      if ([PHASES.SPECIAL_SETUP, PHASES.STAKE_AUCTION, PHASES.FOR_ALL_ANSWERING, PHASES.FOR_ALL_JUDGE,
        PHASES.APPEAL_VOTE,
        PHASES.READING, PHASES.BUZZER_OPEN, PHASES.ANSWERING,
        PHASES.FINAL_WAGER, PHASES.FINAL_QUESTION, PHASES.FINAL_JUDGE].includes(restoredPhase) && game.current) {
        room.engine.played.delete(`${game.roundIndex}:${game.current.themeIndex}:${game.current.questionIndex}`);
        // Replaying a partially scored question must not charge players twice.
        for (const judgment of game.current.judgments ?? []) {
          if (judgment.voided) continue;
          const player = room.participants.get(judgment.playerId);
          if (player) player.score -= judgment.delta;
        }
        room.engine.chooserId = game.current.chooserBeforeQuestion ?? game.chooserId;
      }
      if (restoredPhase === PHASES.REVEAL) {
        if (room.engine.round?.type === 'final') {
          // A completed final answer may lead to another theme when the full-final rule is enabled.
          room.engine.removedFinalThemes.clear();
          const remaining = room.engine.finalThemeIndices().length;
          room.engine.phase = !room.settings.playAllQuestionsInFinalRound || !remaining ||
            (room.engine.roundEndsAt && Date.now() >= room.engine.roundEndsAt)
            ? PHASES.GAME_OVER : remaining > 1 ? PHASES.FINAL_THEMES : PHASES.BOARD;
        } else {
          room.engine.phase = room.engine.roundHasQuestionsLeft() ? PHASES.BOARD : PHASES.ROUND_END;
        }
      } else {
        room.engine.phase = [PHASES.GAME_OVER, PHASES.ROUND_END, PHASES.FINAL_THEMES].includes(restoredPhase)
          ? restoredPhase : PHASES.BOARD;
      }
      room.engine.scheduleRoundEnd();
    }
  } catch (err) {
    console.warn(`[room] State not restored: ${err.message}`);
    room.participants.clear(); room.tokens.clear(); room.ownerId = null; room.loadedPack = null;
    room.engine.reset();
  }
}

export function persistRoom(room, stateFile = file) {
  let pending = null;
  let writeQueue = Promise.resolve();

  const save = () => {
    clearTimeout(pending);
    pending = null;
    const game = room.engine;
    const state = {
      version: 1,
      settings: room.settings,
      ownerId: room.ownerId,
      packFile: room.loadedPack?.file ?? null,
      participants: [...room.participants.values()].map(({ socketId, connected, ...p }) => p),
      game: { phase: game.phase, roundIndex: game.roundIndex, played: [...game.played],
        paused: game.paused,
        removedFinalThemes: [...game.removedFinalThemes],
        chooserId: game.chooserId, roundEndsAt: game.roundEndsAt,
        current: game.current && { themeIndex: game.current.themeIndex, questionIndex: game.current.questionIndex,
          chooserBeforeQuestion: game.current.chooserBeforeQuestion,
          judgments: game.current.judgments } },
    };
    // Serialize writes so a slower earlier save cannot replace newer state.
    writeQueue = writeQueue.then(async () => {
      const temp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fsp.mkdir(path.dirname(stateFile), { recursive: true });
        await fsp.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
        await fsp.rename(temp, stateFile);
      } catch (err) { console.warn(`[room] Save failed: ${err.message}`); }
    });
    return writeQueue;
  };

  const schedule = () => {
    clearTimeout(pending);
    pending = setTimeout(save, 250);
  };
  room.on('change', schedule);

  // Shutdown calls this even if the debounce event has not fired yet.
  return () => {
    room.off('change', schedule);
    return save();
  };
}

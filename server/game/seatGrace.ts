/**
 * Reconnect grace for participants restored from disk (audit CONN-4).
 *
 * Restored participants used to come back with no removal timer. That had two effects:
 * lobby ghosts held their seats, names and the host seat forever, and the first person to
 * reconnect took ownership, because Room.attach only protects an owner whose removal timer
 * is pending. Arming the same timer that a live disconnect uses fixes both.
 *
 * The mode says what happens to a seat when its grace ends:
 * - 'release': follow the live rules (in the lobby the seat is freed).
 * - 'keep': players and the host keep their seat and score even if the room is in the lobby.
 *   This covers a saved game whose pack failed to load: the room falls back to the lobby,
 *   but persistence promises that seats and scores survive a broken pack.
 */
import { config } from '../config.ts';
import { PHASES, type Phase } from './constants.ts';
import type { Room } from './Room.ts';
import { safeTimeout } from '../utils/safeTimer.ts';

export type GraceMode = 'release' | 'keep';

// Kept beside the room instead of on Participant so the mode is never persisted or sent to clients.
const modes = new WeakMap<Room, Map<string, GraceMode>>();

function modesOf(room: Room): Map<string, GraceMode> {
  let map = modes.get(room);
  if (!map) modes.set(room, map = new Map());
  return map;
}

/** A saved lobby (or no saved game) releases ghosts; any started game keeps its seats. */
export function graceModeForSavedPhase(phase: Phase | null | undefined): GraceMode {
  return !phase || phase === PHASES.LOBBY ? 'release' : 'keep';
}

/**
 * Arms the reconnect timer for a restored participant. The handle lives in room.removalTimers
 * so the existing owner guard in Room.attach and the skip in releaseExpiredSeats both see it.
 */
export function armGrace(room: Room, pid: string, mode: GraceMode): void {
  clearTimeout(room.removalTimers.get(pid));
  modesOf(room).set(pid, mode);
  room.removalTimers.set(pid, safeTimeout(`restore grace ${pid}`, () => room.expire(pid),
    config.reconnectGraceMs, () => room.changed()));
}

/**
 * Reads and forgets the mode. Called on attach, remove and expire, so a stale 'keep' from an
 * old restore can never outlive it: a player who reconnects and later drops in a live lobby
 * gets the live rule.
 */
export function takeGraceMode(room: Room, pid: string): GraceMode | undefined {
  const map = modes.get(room);
  const mode = map?.get(pid);
  map?.delete(pid);
  return mode;
}

/**
 * Nicknames: one set of rules for joining and renaming (audit QOL-2).
 *
 * A player on a new phone joins a fresh seat. The host then removes the old offline seat,
 * renames the newcomer to the old name, and adds the score back. Rename never changes a
 * participant's id, so judgments, wagers and the chooser stay attached to the right seat.
 */
import { PHASES } from './constants.ts';
import type { Room } from './Room.ts';

const NICK_MAX = 24;

/** Trims, strips control characters and caps the length. Moved unchanged from Room.join. */
export function normalizeNickname(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, NICK_MAX);
  if (!name) throw new Error('Please enter a nickname');
  return name;
}

/** Names are unique ignoring case; `exceptId` lets a participant keep their own name. */
export function assertNicknameFree(room: Room, name: string, exceptId?: string): void {
  const taken = [...room.participants.values()]
    .some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new Error('This nickname is already taken');
}

/**
 * A moderator may rename anyone at any time. Anyone may rename themselves in the lobby;
 * mid-game a self-rename could be used to impersonate another player on the scoreboard.
 * Calls room.changed() itself: the socket wrapper only broadcasts after game:* events.
 */
export function renameParticipant(room: Room, actorId: string, targetId: string, rawName: unknown): void {
  const target = room.participants.get(targetId);
  if (!target) throw new Error('Unknown participant');
  const moderator = room.canModerate(actorId);
  if (actorId !== targetId && !moderator) throw new Error('Only the host can rename other participants');
  if (!moderator && room.engine.phase !== PHASES.LOBBY) throw new Error('You can change your name in the lobby');
  const name = normalizeNickname(rawName);
  assertNicknameFree(room, name, targetId);
  if (target.name === name) return;
  target.name = name;
  room.changed();
}

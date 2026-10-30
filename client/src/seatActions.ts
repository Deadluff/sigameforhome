/**
 * Which seat actions the host may take now (audit QOL-2).
 *
 * Seating someone, or removing an offline player, mid-question would cut into a live answerer,
 * judgments or wagers. Those actions wait for a calm moment: the lobby, the board, a round end,
 * final theme removal, game over, or a pause taken at one of those.
 */
import type { RoomState } from './types';

const CALM_PHASES = new Set(['lobby', 'board', 'roundEnd', 'finalThemes', 'gameOver']);

export function betweenQuestions(game: Pick<RoomState['game'], 'phase' | 'pausedPhase'>): boolean {
  return CALM_PHASES.has(game.phase) || (game.phase === 'paused' && CALM_PHASES.has(game.pausedPhase ?? ''));
}

/** The remove confirmation names the score, so the host can restore it on the player's new seat. */
export function removeConfirmBody(p: { name: string; role: string; score: number }): string {
  if (p.role !== 'player') return 'They leave the game right away.';
  return `They leave the game right away. ${p.name} has ${p.score.toLocaleString()} points; ` +
    'add them back if they rejoin on a new device.';
}

/**
 * "Give this seat to…" on an offline player's menu (device playtest F7): the player rejoined from
 * another device under a new name; the host picks that newcomer and the old seat, score included,
 * moves to the new device.
 */
export function giveSeatForm(seat: { id: string; name: string }, newcomers: { id: string; name: string }[],
  onGive: (newcomerId: string) => void): HTMLFormElement {
  const form = Object.assign(document.createElement('form'), { className: 'rename-form give-seat-form' });
  const pick = document.createElement('select');
  pick.setAttribute('aria-label', `Who gets ${seat.name}'s seat`);
  for (const p of newcomers) pick.add(new Option(p.name, p.id));
  form.append(pick, Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Give seat' }));
  form.onsubmit = (event) => {
    event.preventDefault();
    if (pick.value) onGive(pick.value);
  };
  return form;
}

/**
 * An inline rename field for a seat menu; `onRename` runs only when the name actually changes.
 * Seats are rebuilt on every snapshot, so the caller passes back any half-typed `draft`.
 */
export function renameForm(seatId: string, name: string, draft: string | undefined, onRename: (next: string) => void): HTMLFormElement {
  const form = Object.assign(document.createElement('form'), { className: 'rename-form' });
  const field = Object.assign(document.createElement('input'), { type: 'text', maxLength: 24, value: draft ?? name });
  field.dataset.playerId = seatId;
  field.setAttribute('aria-label', `New name for ${name}`);
  form.append(field, Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Rename' }));
  form.onsubmit = (event) => {
    event.preventDefault();
    if (field.value.trim() !== name) onRename(field.value);
  };
  return form;
}

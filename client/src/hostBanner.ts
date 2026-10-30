/**
 * Tells everyone why the game is waiting when the host drops (audit UX-4).
 *
 * Host absence used to show only as a small badge on the host's podium, so mid-question the
 * room just sat there. After the server's handover wait the owner may run the game; that person
 * gets their own line so they know the controls on their screen are real.
 */
import type { RoomState } from './types';

export function hostBannerText(state: Pick<RoomState, 'you' | 'participants' | 'game'>): string | null {
  if (!state.you || state.game.phase === 'lobby' || state.game.phase === 'gameOver') return null;
  const host = state.participants.find((p) => p.role === 'host');
  if (!host || host.connected || state.you.role === 'host') return null;
  if (state.you.canModerate) return 'The host is offline. You can run the game until they are back.';
  return 'Host reconnecting — the game waits.';
}

/* Small pure texts for banners and hints, kept apart from the DOM so tests can check them. */

/** Reaction time as people read it: "640 ms" under a second, "18.2 s" above (device playtest F8). */
export function formatReaction(ms: number): string {
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded} ms` : `${(rounded / 1000).toFixed(1)} s`;
}

/** The bidder's hint names only the moves their buttons allow (device playtest F10). */
export function auctionTurnHint(minimumNextBid: number, canBid: boolean, canAllIn: boolean): string {
  const moves = [canBid ? `bid at least ${minimumNextBid}` : '', canAllIn ? 'go all in' : '', 'pass'].filter(Boolean);
  const list = moves.length > 1 ? `${moves.slice(0, -1).join(', ')} or ${moves.at(-1)}` : moves[0];
  return `Your turn. ${list[0].toUpperCase()}${list.slice(1)}.`;
}

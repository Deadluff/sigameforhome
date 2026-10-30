/**
 * Room: the single game table hosted by this server.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import type { LoadedPack } from '../packs/packManager.ts';
import { canonicalMediaPath } from '../packs/htmlAssets.ts';
import type { ContentItem, PackageStats, RoundType } from '../packs/siqParser.ts';
import { PHASES, ROLES, type Role } from './constants.ts';
import { GameEngine, type GameView } from './GameEngine.ts';
import { applySettingsPatch, defaultSettings, type GameSettings } from './settings.ts';
import { takeGraceMode } from './seatGrace.ts';
import { clearHandover, handoverReady, startHandover } from './moderationHandover.ts';
import { assertNicknameFree, normalizeNickname } from './nickname.ts';
import { safeTimeout } from '../utils/safeTimer.ts';

const MAX_MANUAL_SCORE = 1_000_000_000_000;
export const MAX_ROOM_PARTICIPANTS = 64;

export interface Participant {
  id: string;
  token: string;
  mediaTicket: string;
  name: string;
  role: Role;
  score: number;
  connected: boolean;
  socketId: string | null;
  joinedAt: number;
  autoSpectator?: boolean;
  displayOnly?: boolean;
  pingMs?: number | null;
  oneWayMs?: number | null;
  jitterMs?: number | null;
  rttSamples?: number[];
}

export interface RoomSnapshot {
  serverTime: number;
  you: {
    id: string;
    name: string;
    role: Role;
    isOwner: boolean;
    canModerate: boolean;
    canManage: boolean;
  } | null;
  participants: Array<{
    id: string;
    name: string;
    role: Role;
    score: number;
    connected: boolean;
    isOwner: boolean;
    displayOnly: boolean;
    pingMs: number | null;
    oneWayMs: number | null;
    jitterMs: number | null;
  }>;
  settings: GameSettings;
  pack: {
    file: string;
    packId: string;
    name: string;
    logo: string | null;
    difficulty: number;
    authors: string[];
    stats: PackageStats;
    rounds: Array<{ name: string; type: RoundType; themes: number }>;
  } | null;
  game: GameView;
}

export class Room extends EventEmitter {
  participants = new Map<string, Participant>();
  tokens = new Map<string, string>();
  ownerId: string | null = null;
  settings: GameSettings = defaultSettings();
  loadedPack: LoadedPack | null = null;
  engine: GameEngine;
  removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  changeScheduled = false;

  constructor() {
    super();
    this.engine = new GameEngine(this);
  }

  /* ------------------------------------------------------------- queries */

  players(): Participant[] {
    return [...this.participants.values()].filter((p) => p.role === ROLES.PLAYER);
  }

  host(): Participant | null {
    return [...this.participants.values()].find((p) => p.role === ROLES.HOST) ?? null;
  }

  hasFreePlayerSlot(): boolean {
    return this.players().length < this.settings.maxPlayers;
  }

  canModerate(pid: string | null | undefined): boolean {
    if (!pid) return false;
    const p = this.participants.get(pid);
    if (!p || p.displayOnly) return false;
    if (p.role === ROLES.HOST) return true;
    const host = this.host();
    // With no host the owner runs the game; an absent host is covered only after the handover wait.
    return pid === this.ownerId && (!host || (!host.connected && handoverReady(this, host.id)));
  }

  /** Pack/settings management: moderators and the owner. */
  canManage(pid: string | null | undefined): boolean {
    return !!pid && !this.participants.get(pid)?.displayOnly &&
      (pid === this.ownerId || this.canModerate(pid));
  }

  /** Records a client's measured RTT sample (ms) and updates its filtered ping, one-way latency, and jitter. */
  recordPing(pid: string | null | undefined, rawRttMs: unknown): void {
    if (!pid) return;
    const p = this.participants.get(pid);
    if (!p || !p.connected) return;
    const rtt = Number(rawRttMs);
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return;
    const sample = Math.round(rtt);
    p.rttSamples ??= [];
    p.rttSamples.push(sample);
    if (p.rttSamples.length > 8) p.rttSamples.shift();
    const sorted = [...p.rttSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const mean = sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
    const mad = sorted.reduce((acc, v) => acc + Math.abs(v - mean), 0) / sorted.length;
    const prevPing = p.pingMs ?? null;
    p.pingMs = Math.round(median);
    p.oneWayMs = Math.round(median / 2);
    p.jitterMs = Math.round(mad);
    if (prevPing === null || Math.abs(prevPing - p.pingMs) >= 4) {
      this.changed();
    }
  }

  /** True if at least one connected participant (or player) has reported a live RTT measurement. */
  hasMeasuredPing(onlyPlayers = false): boolean {
    for (const p of this.participants.values()) {
      if (!p.connected) continue;
      if (onlyPlayers && p.role !== ROLES.PLAYER) continue;
      if (typeof p.pingMs === 'number' && Number.isFinite(p.pingMs)) return true;
    }
    return false;
  }

  /** Maximum RTT (ms) across all connected participants (or connected players). */
  maxConnectedPingMs(onlyPlayers = false): number {
    let maxPing = 0;
    for (const p of this.participants.values()) {
      if (!p.connected) continue;
      if (onlyPlayers && p.role !== ROLES.PLAYER) continue;
      if (typeof p.pingMs === 'number' && p.pingMs > maxPing) {
        maxPing = p.pingMs;
      }
    }
    return maxPing;
  }

  /* ------------------------------------------------------------ sessions */

  /**
   * Creates a new participant and applies the role-assignment rules.
   * @returns {{ participant: Participant, token: string }}
   */
  join(rawNickname: unknown, asSpectator = false): { participant: Participant; token: string } {
    // Spectators also consume a session, snapshot fan-out, and persisted state.
    if (this.participants.size >= MAX_ROOM_PARTICIPANTS) throw new Error('The room is full');
    const name = normalizeNickname(rawNickname);
    assertNicknameFree(this, name);

    const isFirst = this.ownerId === null;
    if (isFirst && asSpectator) throw new Error('A host or player must join before opening the TV view');
    let role: Role;
    if (isFirst) role = ROLES.PENDING;
    else if (asSpectator) role = ROLES.SPECTATOR;
    // A locked room seats newcomers as spectators; only the host can seat them (audit QOL-3).
    else role = this.hasFreePlayerSlot() && !this.settings.lockRoom ? ROLES.PLAYER : ROLES.SPECTATOR;

    const participant: Participant = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('base64url'),
      mediaTicket: crypto.randomBytes(24).toString('base64url'),
      name,
      role,
      score: 0,
      connected: false,
      socketId: null,
      joinedAt: Date.now(),
      // Auto-assigned spectators are promoted automatically when a player slot frees up.
      // A display-only TV never inherits a player seat when one opens.
      autoSpectator: role === ROLES.SPECTATOR && !asSpectator && !this.settings.lockRoom,
      displayOnly: asSpectator,
    };
    this.participants.set(participant.id, participant);
    this.tokens.set(participant.token, participant.id);
    if (isFirst) this.ownerId = participant.id;

    this.changed();
    return { participant, token: participant.token };
  }

  resume(token: unknown): Participant | null {
    const pid = this.tokens.get(String(token ?? ''));
    return pid ? (this.participants.get(pid) ?? null) : null;
  }

  attach(pid: string, socketId: string): string | null {
    const p = this.participants.get(pid);
    if (!p) return null;
    // A new socket must not revive media URLs captured from an earlier connection.
    p.mediaTicket = crypto.randomBytes(24).toString('base64url');
    const previous = p.socketId && p.socketId !== socketId ? p.socketId : null;
    p.socketId = socketId;
    p.connected = true;
    this.promoteSpectators();
    if (this.ownerId && !this.participants.get(this.ownerId)?.connected &&
        !this.removalTimers.has(this.ownerId)) this.reassignOwner();
    const removalTimer = this.removalTimers.get(pid);
    if (removalTimer) clearTimeout(removalTimer);
    this.removalTimers.delete(pid);
    takeGraceMode(this, pid); // a reconnect ends any restore grace; later drops follow live rules
    clearHandover(this, pid);
    this.changed();
    return previous;
  }

  detach(pid: string, socketId: string): void {
    const p = this.participants.get(pid);
    if (!p || p.socketId !== socketId) return;
    const wasAuctionTurn = this.engine.phase === PHASES.STAKE_AUCTION &&
      this.engine.auctionTurnId() === pid;
    p.connected = false;
    p.socketId = null;
    if (p.role === ROLES.HOST) startHandover(this, pid);
    this.removalTimers.set(
      pid,
      safeTimeout(`reconnect grace ${pid}`, () => this.expire(pid), config.reconnectGraceMs, () => this.changed()),
    );
    // A disconnected bidder cannot act, so offer the turn to the next player now.
    if (wasAuctionTurn) this.engine.advanceStakeAuction();
    this.engine.advanceForAllAfterRosterChange();
    this.changed();
  }

  expire(pid: string): void {
    const p = this.participants.get(pid);
    this.removalTimers.delete(pid);
    // A restored 'keep' seat survives a lobby fallback (e.g. its saved pack failed to load).
    const keepRestored = takeGraceMode(this, pid) === 'keep';
    if (!p || p.connected) return;
    const inGame = this.engine.phase !== PHASES.LOBBY || keepRestored;
    if (inGame && (p.role === ROLES.PLAYER || p.role === ROLES.HOST)) {
      // Keep scores/seats for reconnects, but let a connected participant recover moderation.
      if (this.ownerId === pid) {
        this.reassignOwner();
        this.changed();
      }
      return;
    }
    this.remove(pid);
  }

  /** Once play ends, departed seats with no reconnect grace left should free lobby slots. */
  releaseExpiredSeats(): void {
    for (const p of [...this.participants.values()]) {
      if (!p.connected && !this.removalTimers.has(p.id)) this.remove(p.id);
    }
  }

  remove(pid: string): void {
    const p = this.participants.get(pid);
    if (!p) return;
    const wasAuctionTurn = this.engine.phase === PHASES.STAKE_AUCTION &&
      this.engine.auctionTurnId() === pid;
    clearTimeout(this.removalTimers.get(pid));
    this.removalTimers.delete(pid);
    takeGraceMode(this, pid);
    clearHandover(this, pid);
    this.participants.delete(pid);
    this.tokens.delete(p.token);
    if (this.engine.chooserId === pid) this.engine.chooserId = this.players()[0]?.id ?? null;
    if (this.ownerId === pid) this.reassignOwner();
    this.promoteSpectators();
    if (wasAuctionTurn) this.engine.advanceStakeAuction();
    this.engine.advanceForAllAfterRosterChange();
    this.changed();
  }

  reassignOwner(): void {
    const candidates = [...this.participants.values()].filter((p) => !p.displayOnly).sort(
      (a, b) => Number(b.connected) - Number(a.connected) ||
        Number(b.role === ROLES.PLAYER || b.role === ROLES.HOST) -
        Number(a.role === ROLES.PLAYER || a.role === ROLES.HOST) || a.joinedAt - b.joinedAt,
    );
    this.ownerId = candidates.find((p) => p.connected)?.id ?? candidates[0]?.id ?? null;
    // If the new owner never chose a role (impossible today, but keep invariants) nothing else to do.
    // If everyone left, the next joiner becomes the new "first" and gets the Host/Player choice.
  }

  promoteSpectators(): void {
    if (this.engine.phase !== PHASES.LOBBY && this.engine.phase !== PHASES.GAME_OVER) return;
    const waiting = [...this.participants.values()]
      // A locked room freezes seating, also for people who were waiting before the lock (QOL-3).
      .filter((p) => !this.settings.lockRoom && p.connected && p.role === ROLES.SPECTATOR && p.autoSpectator && !p.displayOnly)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    for (const s of waiting) {
      if (!this.hasFreePlayerSlot()) break;
      s.role = ROLES.PLAYER;
      delete s.autoSpectator;
    }
  }

  /* --------------------------------------------------------------- roles */

  chooseInitialRole(pid: string, role: Role): void {
    const p = this.participants.get(pid);
    if (!p || p.role !== ROLES.PENDING) throw new Error('You have already chosen a role');
    if (role === ROLES.HOST) {
      if (this.host()) throw new Error('A host is already assigned');
      p.role = ROLES.HOST;
    } else if (role === ROLES.PLAYER) {
      p.role = this.hasFreePlayerSlot() ? ROLES.PLAYER : ROLES.SPECTATOR;
    } else {
      throw new Error('Choose either host or player');
    }
    this.changed();
  }

  setRole(actorId: string, targetId: string, role: Role): void {
    const target = this.participants.get(targetId);
    if (!target) throw new Error('Unknown participant');
    if (target.displayOnly && role !== ROLES.SPECTATOR) throw new Error('TV views remain spectators');
    if (role !== ROLES.HOST && role !== ROLES.PLAYER && role !== ROLES.SPECTATOR) {
      throw new Error('Invalid role');
    }
    if (target.role === role) return;
    if (this.engine.phase !== PHASES.LOBBY && role === ROLES.HOST && target.role === ROLES.PLAYER) {
      throw new Error('A player cannot become host during a game');
    }

    const self = actorId === targetId;
    const moderator = this.canModerate(actorId);

    if (role === ROLES.HOST) {
      const host = this.host();
      if (host && host.id !== targetId) throw new Error('The host seat is taken');
      if (!moderator && !(self && actorId === this.ownerId)) throw new Error('Only the owner can claim the host seat');
    } else {
      if (!self && !moderator) throw new Error('You cannot change other participants');
      if (role === ROLES.PLAYER && !moderator && this.settings.lockRoom) throw new Error('The room is locked');
      if (role === ROLES.PLAYER && !this.hasFreePlayerSlot()) throw new Error('All player slots are taken');
    }

    const wasAuctionTurn = this.engine.phase === PHASES.STAKE_AUCTION &&
      this.engine.auctionTurnId() === targetId;
    target.role = role;
    delete target.autoSpectator;
    // A released host seat ends that host's wait; an offline new host starts one, or the owner could
    // never moderate (the seat is kept for the whole game and only a moderator can release it).
    if (role === ROLES.HOST && !target.connected) startHandover(this, targetId);
    else clearHandover(this, targetId);
    this.promoteSpectators();
    // A reseated bidder cannot act, so let the next eligible player bid immediately.
    if (wasAuctionTurn && role !== ROLES.PLAYER) this.engine.advanceStakeAuction();
    this.engine.advanceForAllAfterRosterChange();
    this.changed();
  }

  kick(actorId: string, targetId: string): void {
    if (!this.canModerate(actorId)) throw new Error('Only the host can remove participants');
    if (actorId === targetId) throw new Error('You cannot remove yourself');
    const target = this.participants.get(targetId);
    if (!target) return;
    this.remove(targetId);
    this.emit('kicked', target);
  }

  /* ---------------------------------------------------- settings & packs */

  updateSettings(actorId: string, patch: Partial<Record<string, unknown>>): void {
    if (!this.canManage(actorId)) throw new Error('Only the host or owner can change settings');
    const next = applySettingsPatch(this.settings, patch);
    // Switching answer input while a question is live would strand the current answerer.
    if (next.oral !== this.settings.oral &&
      this.engine.phase !== PHASES.LOBBY && this.engine.phase !== PHASES.GAME_OVER) {
      throw new Error('Change oral answer mode before starting a game');
    }
    if (next.maxPlayers < this.players().length) throw new Error('More players are seated than the new limit');
    this.settings = next;
    this.promoteSpectators();
    this.changed();
  }

  setPack(loaded: LoadedPack): void {
    if (this.engine.phase !== PHASES.LOBBY) throw new Error('Stop the current game before changing the pack');
    this.loadedPack = loaded;
    this.changed();
  }

  adjustScore(actorId: string, targetId: string, delta: number): void {
    if (!this.canModerate(actorId)) throw new Error('Only the host can change scores');
    const p = this.participants.get(targetId);
    if (!p) throw new Error('Unknown participant');
    // Leave room for the bounded pack's remaining question values to change the score.
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(p.score + delta) ||
        Math.abs(p.score + delta) > MAX_MANUAL_SCORE) {
      throw new Error('Score change must keep a safe whole-number score within ±1 trillion');
    }
    p.score += delta;
    this.changed();
  }

  /* ------------------------------------------------------------- output */

  changed(): void {
    if (this.changeScheduled) return;
    this.changeScheduled = true;
    setImmediate(() => {
      this.changeScheduled = false;
      this.emit('change');
    });
  }

  emitEvent(evt: Record<string, unknown>): void {
    this.emit('event', { ...evt, at: Date.now() });
  }

  /** Media tickets identify a viewer without exposing their session token in URLs. */
  mediaUrl(url: string | null | undefined, viewer: Participant | null, type?: ContentItem['type']): string | null {
    if (!url?.startsWith('/media/') || !viewer) return url ?? null;
    // A path ticket also reaches relative resources loaded inside sandboxed HTML.
    return type === 'html' ? url.replace('/media/', `/media-html/${viewer.mediaTicket}/`)
      : `${url}?ticket=${viewer.mediaTicket}`;
  }

  canAccessMedia(ticket: unknown, requestPath: string): boolean {
    if (typeof ticket !== 'string' || !ticket) return false;
    const viewer = [...this.participants.values()].find((p) => p.mediaTicket === ticket);
    const current = this.engine.current;
    if (!viewer?.connected || !this.loadedPack) return false;
    const canonical = canonicalMediaPath;
    let requested;
    try {
      requested = requestPath.split('/').map(decodeURIComponent).join('/');
    } catch { return false; }
    const allowed = (item: ContentItem | null | undefined): boolean => {
      const source = canonical(item?.url);
      if (!source) return false;
      if (source === requested) return true;
      if (item?.type === 'html') {
        const assets = this.loadedPack?.htmlAssets?.get(source);
        if (assets?.has(requested)) return true;
        if (assets?.size) for (const asset of assets) {
          const parts = asset.split('/');
          const derived = `/media/${parts[2]}/_derived/${parts.slice(3).join('/')}.ios.`;
          if (requested === `${derived}mp4` || requested === `${derived}mp3`) return true;
        }
      }
      // Derivatives live outside archive media folders, so a pack-authored file
      // with an .ios suffix cannot inherit access to a visible source clip.
      const parts = source.split('/');
      const generated = (ext: string) => `/media/${parts[2]}/_derived/${parts.slice(3).join('/')}.ios.${ext}`;
      return (item?.type === 'video' && requested === generated('mp4')) ||
        (item?.type === 'audio' && requested === generated('mp3'));
    };
    if (allowed(this.loadedPack.pack.logo)) return true;
    if (!current || current.type === 'secretNoQuestion') return false;
    // Same gate as the state view, so a file never loads before its question is on screen.
    const visible = !this.engine.contentHidden();
    if (visible && current.question.content.some(allowed)) return true;
    if (visible && (current.question.answerOptions ?? []).some((option) => option.content.some(allowed))) return true;
    const canSeeAnswer = viewer.role === ROLES.HOST || current.answerShown;
    return canSeeAnswer && current.question.answerContent.some(allowed);
  }

  /** Personalised state for one participant. */
  snapshotFor(pid: string): RoomSnapshot {
    const viewer = this.participants.get(pid) ?? null;
    const canModerate = this.canModerate(pid);
    const loadedPack = this.loadedPack;
    const pack = loadedPack?.pack;
    const game = this.engine.getView(viewer, canModerate);
    if (game.current) {
      game.current.content = game.current.content.map((item) => ({ ...item, url: this.mediaUrl(item.url, viewer, item.type) }));
      game.current.answerOptions = (game.current.answerOptions ?? []).map((option) => ({ ...option,
        content: option.content.map((item) => ({ ...item, url: this.mediaUrl(item.url, viewer, item.type) })) }));
      if (game.current.answerContent) {
        game.current.answerContent = game.current.answerContent.map((item) =>
          ({ ...item, url: this.mediaUrl(item.url, viewer, item.type) }));
      }
    }

    return {
      serverTime: Date.now(),
      you: viewer
        ? {
            id: viewer.id,
            name: viewer.name,
            role: viewer.role,
            isOwner: viewer.id === this.ownerId,
            canModerate,
            canManage: this.canManage(pid),
          }
        : null,
      participants: [...this.participants.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          id: p.id,
          name: p.name,
          role: p.role,
          score: p.score,
          connected: p.connected,
          isOwner: p.id === this.ownerId,
          displayOnly: !!p.displayOnly,
          pingMs: p.pingMs ?? null,
          oneWayMs: p.oneWayMs ?? null,
          jitterMs: p.jitterMs ?? null,
        })),
      settings: this.settings,
      pack: pack && loadedPack ? {
        file: loadedPack.file,
        packId: loadedPack.packId,
        name: pack.name,
        logo: this.mediaUrl(pack.logo?.url ?? null, viewer),
        difficulty: pack.difficulty,
        authors: pack.info.authors,
        stats: pack.stats,
        rounds: pack.rounds.map((r) => ({ name: r.name, type: r.type, themes: r.themes.length })),
      } : null,
      game,
    };
  }
}

/**
 * Room: the single game table hosted by this server.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import type { LoadedPack } from '../packs/packManager.ts';
import type { PackageStats, RoundType } from '../packs/siqParser.ts';
import { PHASES, ROLES, type Role } from './constants.ts';
import { GameEngine, type GameView } from './GameEngine.ts';
import { applySettingsPatch, defaultSettings, type GameSettings } from './settings.ts';

const NICK_MAX = 24;

export interface Participant {
  id: string;
  token: string;
  name: string;
  role: Role;
  score: number;
  connected: boolean;
  socketId: string | null;
  joinedAt: number;
  autoSpectator?: boolean;
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
    if (!p) return false;
    if (p.role === ROLES.HOST) return true;
    const host = this.host();
    return pid === this.ownerId && !(host && host.connected);
  }

  canManage(pid: string | null | undefined): boolean {
    if (!pid) return false;
    return pid === this.ownerId || this.canModerate(pid);
  }

  /* ------------------------------------------------------------ sessions */

  join(rawNickname: unknown): { participant: Participant; token: string } {
    const name = String(rawNickname ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, NICK_MAX);
    if (!name) throw new Error('Please enter a nickname');

    const taken = [...this.participants.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new Error('This nickname is already taken');

    const isFirst = this.ownerId === null;
    const role: Role = isFirst ? ROLES.PENDING : this.hasFreePlayerSlot() ? ROLES.PLAYER : ROLES.SPECTATOR;

    const participant: Participant = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('base64url'),
      name,
      role,
      score: 0,
      connected: false,
      socketId: null,
      joinedAt: Date.now(),
      autoSpectator: role === ROLES.SPECTATOR,
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
    const previous = p.socketId && p.socketId !== socketId ? p.socketId : null;
    p.socketId = socketId;
    p.connected = true;
    clearTimeout(this.removalTimers.get(pid));
    this.removalTimers.delete(pid);
    this.changed();
    return previous;
  }

  detach(pid: string, socketId: string): void {
    const p = this.participants.get(pid);
    if (!p || p.socketId !== socketId) return;
    p.connected = false;
    p.socketId = null;
    this.removalTimers.set(
      pid,
      setTimeout(() => this.expire(pid), config.reconnectGraceMs),
    );
    this.changed();
  }

  expire(pid: string): void {
    const p = this.participants.get(pid);
    this.removalTimers.delete(pid);
    if (!p || p.connected) return;
    const inGame = this.engine.phase !== PHASES.LOBBY;
    if (inGame && (p.role === ROLES.PLAYER || p.role === ROLES.HOST)) return;
    this.remove(pid);
  }

  remove(pid: string): void {
    const p = this.participants.get(pid);
    if (!p) return;
    clearTimeout(this.removalTimers.get(pid));
    this.removalTimers.delete(pid);
    this.participants.delete(pid);
    this.tokens.delete(p.token);
    if (this.engine.chooserId === pid) this.engine.chooserId = this.players()[0]?.id ?? null;
    if (this.ownerId === pid) this.reassignOwner();
    this.promoteSpectators();
    this.changed();
  }

  reassignOwner(): void {
    const candidates = [...this.participants.values()].sort(
      (a, b) => Number(b.connected) - Number(a.connected) || a.joinedAt - b.joinedAt,
    );
    this.ownerId = candidates[0]?.id ?? null;
  }

  promoteSpectators(): void {
    if (this.engine.phase !== PHASES.LOBBY) return;
    const waiting = [...this.participants.values()]
      .filter((p) => p.role === ROLES.SPECTATOR && p.autoSpectator)
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
    if (!([ROLES.HOST, ROLES.PLAYER, ROLES.SPECTATOR] as readonly string[]).includes(role)) {
      throw new Error('Invalid role');
    }
    if (target.role === role) return;

    const self = actorId === targetId;
    const moderator = this.canModerate(actorId);

    if (role === ROLES.HOST) {
      const host = this.host();
      if (host && host.id !== targetId) throw new Error('The host seat is taken');
      if (!moderator && !(self && actorId === this.ownerId)) throw new Error('Only the owner can claim the host seat');
    } else {
      if (!self && !moderator) throw new Error('You cannot change other participants');
      if (role === ROLES.PLAYER && !this.hasFreePlayerSlot()) throw new Error('All player slots are taken');
    }

    target.role = role;
    delete target.autoSpectator;
    this.promoteSpectators();
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
    if (!Number.isFinite(delta)) throw new Error('Invalid amount');
    p.score += Math.trunc(delta);
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

  snapshotFor(pid: string): RoomSnapshot {
    const viewer = this.participants.get(pid) ?? null;
    const canModerate = this.canModerate(pid);
    const pack = this.loadedPack?.pack ?? null;

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
        })),
      settings: this.settings,
      pack:
        pack && this.loadedPack
          ? {
              file: this.loadedPack.file,
              packId: this.loadedPack.packId,
              name: pack.name,
              logo: pack.logo?.url ?? null,
              difficulty: pack.difficulty,
              authors: pack.info.authors,
              stats: pack.stats,
              rounds: pack.rounds.map((r) => ({ name: r.name, type: r.type, themes: r.themes.length })),
            }
          : null,
      game: this.engine.getView(viewer, canModerate),
    };
  }
}

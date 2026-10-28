/**
 * Room: the single game table hosted by this server.
 *
 * Responsibilities
 *  - participants & sessions (reconnect via secret token, grace period for dropped phones)
 *  - role assignment rules:
 *      • the FIRST person to join gets role "pending" and chooses Host or Player
 *      • everyone after that is auto-assigned Player, or Spectator when slots are full
 *  - ownership: the first joiner is the "owner" (like SIGame's game creator). The owner can
 *    load packs/change settings even when playing, and inherits moderation if there's no
 *    connected host. Ownership passes on if the owner leaves for good.
 *  - settings, loaded pack, and the GameEngine instance
 *
 * The Room is transport-agnostic: it emits
 *    'change'            – state changed, re-send snapshots (coalesced per tick)
 *    'event' (evt)       – transient game events (buzz, false start…) for sounds/animations
 *    'kicked' (pid)      – participant removed by moderator
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { PHASES, ROLES } from './constants.js';
import { GameEngine } from './GameEngine.js';
import { applySettingsPatch, defaultSettings } from './settings.js';

const NICK_MAX = 24;

/**
 * @typedef {object} Participant
 * @property {string} id         public id (safe to broadcast)
 * @property {string} token      secret session token (never broadcast)
 * @property {string} name
 * @property {string} role       one of ROLES
 * @property {number} score
 * @property {boolean} connected
 * @property {string|null} socketId
 * @property {number} joinedAt
 */

export class Room extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Participant>} */
    this.participants = new Map();
    /** @type {Map<string, string>} token → participant id */
    this.tokens = new Map();
    this.ownerId = null;
    this.settings = defaultSettings();
    /** @type {{ packId: string, file: string, pack: import('../packs/siqParser.js').Package } | null} */
    this.loadedPack = null;
    this.engine = new GameEngine(this);
    this.removalTimers = new Map();
    this.changeScheduled = false;
  }

  /* ------------------------------------------------------------- queries */

  players() {
    return [...this.participants.values()].filter((p) => p.role === ROLES.PLAYER);
  }

  host() {
    return [...this.participants.values()].find((p) => p.role === ROLES.HOST) ?? null;
  }

  hasFreePlayerSlot() {
    return this.players().length < this.settings.maxPlayers;
  }

  /** Host always moderates; the owner moderates when no host is connected. */
  canModerate(pid) {
    const p = this.participants.get(pid);
    if (!p) return false;
    if (p.role === ROLES.HOST) return true;
    const host = this.host();
    return pid === this.ownerId && !(host && host.connected);
  }

  /** Pack/settings management: moderators and the owner. */
  canManage(pid) {
    return pid === this.ownerId || this.canModerate(pid);
  }

  /* ------------------------------------------------------------ sessions */

  /**
   * Creates a new participant and applies the role-assignment rules.
   * @returns {{ participant: Participant, token: string }}
   */
  join(rawNickname) {
    const name = String(rawNickname ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, NICK_MAX);
    if (!name) throw new Error('Please enter a nickname');

    const taken = [...this.participants.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) throw new Error('This nickname is already taken');

    const isFirst = this.ownerId === null;
    let role;
    if (isFirst) role = ROLES.PENDING;
    else role = this.hasFreePlayerSlot() ? ROLES.PLAYER : ROLES.SPECTATOR;

    /** @type {Participant} */
    const participant = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('base64url'),
      name,
      role,
      score: 0,
      connected: false,
      socketId: null,
      joinedAt: Date.now(),
      // Auto-assigned spectators are promoted automatically when a player slot frees up.
      autoSpectator: role === ROLES.SPECTATOR,
    };
    this.participants.set(participant.id, participant);
    this.tokens.set(participant.token, participant.id);
    if (isFirst) this.ownerId = participant.id;

    this.changed();
    return { participant, token: participant.token };
  }

  /** @returns {Participant|null} participant for a stored session token */
  resume(token) {
    const pid = this.tokens.get(String(token ?? ''));
    return pid ? (this.participants.get(pid) ?? null) : null;
  }

  /** Binds a socket to a participant. Returns the previous socket id (to disconnect a stale tab). */
  attach(pid, socketId) {
    const p = this.participants.get(pid);
    const previous = p.socketId && p.socketId !== socketId ? p.socketId : null;
    p.socketId = socketId;
    p.connected = true;
    clearTimeout(this.removalTimers.get(pid));
    this.removalTimers.delete(pid);
    this.changed();
    return previous;
  }

  /** Socket dropped: keep the seat for a grace period. */
  detach(pid, socketId) {
    const p = this.participants.get(pid);
    if (!p || p.socketId !== socketId) return; // a newer socket already took over
    p.connected = false;
    p.socketId = null;
    this.removalTimers.set(
      pid,
      setTimeout(() => this.expire(pid), config.reconnectGraceMs),
    );
    this.changed();
  }

  /** Grace period over. Players keep their seat (and score) during a running game. */
  expire(pid) {
    const p = this.participants.get(pid);
    this.removalTimers.delete(pid);
    if (!p || p.connected) return;
    const inGame = this.engine.phase !== PHASES.LOBBY;
    if (inGame && (p.role === ROLES.PLAYER || p.role === ROLES.HOST)) return;
    this.remove(pid);
  }

  remove(pid) {
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

  reassignOwner() {
    const candidates = [...this.participants.values()].sort(
      (a, b) => Number(b.connected) - Number(a.connected) || a.joinedAt - b.joinedAt,
    );
    this.ownerId = candidates[0]?.id ?? null;
    // If the new owner never chose a role (impossible today, but keep invariants) nothing else to do.
    // If everyone left, the next joiner becomes the new "first" and gets the Host/Player choice.
  }

  /** Fills freed player slots with the longest-waiting spectators (lobby only). */
  promoteSpectators() {
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

  /** The first joiner's one-time Host / Player decision. */
  chooseInitialRole(pid, role) {
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

  /**
   * Role changes after the initial choice.
   *  - moderators can move anyone between player/spectator, and appoint a host if the seat is free
   *  - anyone can switch themselves between player/spectator (if a slot is free)
   *  - the owner can claim a vacant host seat
   */
  setRole(actorId, targetId, role) {
    const target = this.participants.get(targetId);
    if (!target) throw new Error('Unknown participant');
    if (![ROLES.HOST, ROLES.PLAYER, ROLES.SPECTATOR].includes(role)) throw new Error('Invalid role');
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

  kick(actorId, targetId) {
    if (!this.canModerate(actorId)) throw new Error('Only the host can remove participants');
    if (actorId === targetId) throw new Error('You cannot remove yourself');
    const target = this.participants.get(targetId);
    if (!target) return;
    this.remove(targetId);
    this.emit('kicked', target);
  }

  /* ---------------------------------------------------- settings & packs */

  updateSettings(actorId, patch) {
    if (!this.canManage(actorId)) throw new Error('Only the host or owner can change settings');
    const next = applySettingsPatch(this.settings, patch);
    if (next.maxPlayers < this.players().length) throw new Error('More players are seated than the new limit');
    this.settings = next;
    this.promoteSpectators();
    this.changed();
  }

  setPack(loaded) {
    if (this.engine.phase !== PHASES.LOBBY) throw new Error('Stop the current game before changing the pack');
    this.loadedPack = loaded;
    this.changed();
  }

  adjustScore(actorId, targetId, delta) {
    if (!this.canModerate(actorId)) throw new Error('Only the host can change scores');
    const p = this.participants.get(targetId);
    if (!p) throw new Error('Unknown participant');
    if (!Number.isFinite(delta)) throw new Error('Invalid amount');
    p.score += Math.trunc(delta);
    this.changed();
  }

  /* ------------------------------------------------------------- output */

  /** Coalesces many mutations in one tick into a single broadcast. */
  changed() {
    if (this.changeScheduled) return;
    this.changeScheduled = true;
    setImmediate(() => {
      this.changeScheduled = false;
      this.emit('change');
    });
  }

  emitEvent(evt) {
    this.emit('event', { ...evt, at: Date.now() });
  }

  /** Personalised state for one participant. */
  snapshotFor(pid) {
    const viewer = this.participants.get(pid) ?? null;
    const canModerate = this.canModerate(pid);
    const pack = this.loadedPack?.pack;

    return {
      serverTime: Date.now(), // lets clients correct clock skew for countdowns
      you: viewer && {
        id: viewer.id,
        name: viewer.name,
        role: viewer.role,
        isOwner: viewer.id === this.ownerId,
        canModerate,
        canManage: this.canManage(pid),
      },
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
      pack: pack && {
        file: this.loadedPack.file,
        packId: this.loadedPack.packId,
        name: pack.name,
        logo: pack.logo?.url ?? null,
        difficulty: pack.difficulty,
        authors: pack.info.authors,
        stats: pack.stats,
        rounds: pack.rounds.map((r) => ({ name: r.name, type: r.type, themes: r.themes.length })),
      },
      game: this.engine.getView(viewer, canModerate),
    };
  }
}

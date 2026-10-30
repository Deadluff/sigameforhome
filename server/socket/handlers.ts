/**
 * Socket.io transport: maps client events to Room / GameEngine calls.
 */
import type { Server, Socket } from 'socket.io';
import { PHASES, type Role } from '../game/constants.ts';
import type { Participant, Room } from '../game/Room.ts';
import { SETTINGS_SCHEMA } from '../game/settings.ts';
import { renameParticipant } from '../game/nickname.ts';
import { listPacks, loadPack } from '../packs/packManager.ts';
import { downloadWorkshopPack } from '../steam/workshop.ts';
import { createSocketLimits, type SocketLimits } from './socketLimits.ts';

const JOINED_ROOM = 'joined';
const JOIN_WINDOW_MS = 60_000;
const JOIN_ATTEMPT_LIMIT = 20;
const COMMAND_WINDOW_MS = 10_000;
const COMMAND_ATTEMPT_LIMIT = 120;
const CLOCK_PROBE_LIMIT = 50;

type AccessLevel = 'none' | 'member' | 'moderator' | 'manager';
type AckCallback = (res: Record<string, unknown>) => void;

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Verdict must be true or false');
  return value;
}

export function registerSocketHandlers(io: Server, room: Room, limits: SocketLimits = createSocketLimits()): void {
  const joinAttempts = new Map<string, { startedAt: number; count: number }>();
  const checkJoinRate = (address: string): void => {
    const now = Date.now();
    const current = joinAttempts.get(address);
    const attempts = !current || now - current.startedAt >= JOIN_WINDOW_MS
      ? { startedAt: now, count: 0 } : current;
    if (attempts.count >= JOIN_ATTEMPT_LIMIT) throw new Error('Too many join attempts; try again shortly');
    attempts.count++;
    joinAttempts.set(address, attempts);
    // Keep old addresses from accumulating after many transient LAN connections.
    if (joinAttempts.size > 256) {
      for (const [key, value] of joinAttempts) {
        if (now - value.startedAt >= JOIN_WINDOW_MS) joinAttempts.delete(key);
      }
    }
  };

  /* ---------------------------------------------- room → clients fan-out */

  room.on('change', () => {
    for (const p of room.participants.values()) {
      if (p.socketId) io.to(p.socketId).emit('room:state', room.snapshotFor(p.id));
    }
  });

  room.on('event', (evt: Record<string, unknown>) => io.to(JOINED_ROOM).emit('game:event', evt));

  room.on('kicked', (p: Participant) => {
    if (!p.socketId) return;
    const s = io.sockets.sockets.get(p.socketId);
    s?.emit('session:kicked');
    s?.leave(JOINED_ROOM);
    if (s) { s.data.pid = null; limits.left(s); } // still connected, so it counts as unjoined again
  });

  const emitToManagers = (event: string, payload: unknown): void => {
    for (const p of room.participants.values()) {
      if (p.socketId && room.canManage(p.id)) io.to(p.socketId).emit(event, payload);
    }
  };

  /* ------------------------------------------------------ per connection */

  io.on('connection', (socket: Socket) => {
    limits.connected(socket);
    socket.data.pid = null as string | null;
    let commandWindowStartedAt = Date.now();
    let commandAttempts = 0;
    let clockWindowStartedAt = Date.now();
    let clockProbes = 0;

    const on = <TPayload = Record<string, any>>(
      event: string,
      access: AccessLevel,
      handler: (payload: TPayload, pid: string) => unknown,
    ): void => {
      socket.on(event, async (rawPayload?: TPayload | AckCallback, rawAck?: AckCallback) => {
        const [payload, ack] =
          typeof rawPayload === 'function'
            ? [undefined as unknown as TPayload, rawPayload as AckCallback]
            : [rawPayload as TPayload, rawAck];
        const reply: AckCallback = typeof ack === 'function' ? ack : () => {};
        try {
          // Keep a broken client from flooding validation and acknowledgments.
          const now = Date.now();
          if (event === 'clock:ping') {
            // The client's four-probe reconnect burst must work after command throttling.
            if (now - clockWindowStartedAt >= COMMAND_WINDOW_MS) {
              clockWindowStartedAt = now;
              clockProbes = 0;
            }
            if (++clockProbes > CLOCK_PROBE_LIMIT) throw new Error('Too many clock probes; try again shortly');
          } else {
            if (now - commandWindowStartedAt >= COMMAND_WINDOW_MS) {
              commandWindowStartedAt = now;
              commandAttempts = 0;
            }
            if (++commandAttempts > COMMAND_ATTEMPT_LIMIT) {
              throw new Error('Too many commands; try again shortly');
            }
          }
          const pid = socket.data.pid as string | null;
          if (access !== 'none' && !pid) throw new Error('Join the game first');
          if (access !== 'none' && room.participants.get(pid!)?.socketId !== socket.id) {
            throw new Error('Session is no longer active');
          }
          if (access === 'moderator' && !room.canModerate(pid)) throw new Error('Only the host can do that');
          if (access === 'manager' && !room.canManage(pid)) throw new Error('Only the host or owner can do that');
          const result = await handler((payload ?? ({} as TPayload)), pid ?? '');
          // Ignored repeat buzzes do not alter state and should not trigger room-wide snapshots.
          if (event.startsWith('game:') &&
              !(event === 'game:buzz' && (result as { result?: string } | null)?.result === 'ignored') &&
              !(event === 'game:contentFinished' && (result as { advanced?: boolean } | null)?.advanced === false) &&
              !(event === 'game:questionReady' && (result as { ready?: boolean } | null)?.ready === false)) room.changed();
          reply({ ok: true, ...(typeof result === 'object' && result !== null ? result : {}) });
        } catch (err) {
          reply({ ok: false, error: (err as Error).message });
        }
      });
    };

    const bind = (participant: Participant): void => {
      const stale = room.attach(participant.id, socket.id);
      if (stale) io.sockets.sockets.get(stale)?.disconnect(true);
      socket.data.pid = participant.id;
      socket.join(JOINED_ROOM);
      limits.joined(socket);
    };

    /* ---- clock sync ---- */

    on<{ rttMs?: number }>('clock:ping', 'none', (payload) => {
      if (socket.data.pid && payload?.rttMs !== undefined) {
        room.recordPing(socket.data.pid as string, payload.rttMs);
      }
      return {
        serverTime: Date.now(),
        maxPingMs: room.maxConnectedPingMs(),
      };
    });

    /* ---- session ---- */

    on<{ token?: string }>('session:resume', 'none', ({ token }) => {
      if (socket.data.pid) throw new Error('Already joined');
      const participant = room.resume(token);
      if (!participant) return { resumed: false };
      bind(participant);
      return { resumed: true };
    });

    on<{ nickname?: string; asSpectator?: boolean }>('session:join', 'none', ({ nickname, asSpectator }) => {
      if (socket.data.pid) throw new Error('Already joined');
      checkJoinRate(socket.handshake?.address || socket.id);
      const { participant, token } = room.join(nickname, asSpectator === true);
      bind(participant);
      return { token, role: participant.role };
    });

    on('session:leave', 'member', (_, pid) => {
      room.remove(pid);
      socket.data.pid = null;
      socket.leave(JOINED_ROOM);
      limits.left(socket);
    });

    /* ---- roles ---- */

    on<{ role: Role }>('role:choose', 'member', ({ role }, pid) => room.chooseInitialRole(pid, role));
    on<{ targetId?: string; role: Role }>('role:set', 'member', ({ targetId, role }, pid) =>
      room.setRole(pid, targetId ?? pid, role),
    );
    on<{ targetId: string }>('participant:kick', 'moderator', ({ targetId }, pid) => room.kick(pid, targetId));
    on<{ targetId?: string; name: string }>('participant:rename', 'member', ({ targetId, name }, pid) =>
      renameParticipant(room, pid, targetId ?? pid, name));
    on<{ targetId: string; delta: number }>('score:adjust', 'moderator', ({ targetId, delta }, pid) =>
      room.adjustScore(pid, targetId, Number(delta)),
    );

    /* ---- settings & packs ---- */

    on('settings:schema', 'none', () => ({ schema: SETTINGS_SCHEMA }));
    on<Record<string, unknown>>('settings:update', 'manager', (patch, pid) => room.updateSettings(pid, patch));

    on('packs:list', 'manager', async () => ({ packs: await listPacks() }));

    on<{ file: string }>('packs:load', 'manager', async ({ file }, pid) => {
      if (room.engine.phase !== PHASES.LOBBY) throw new Error('Stop the current game before changing the pack');
      const loaded = await loadPack(file);
      // Loading can outlive the socket or its manager role; recheck before changing the room.
      if (room.participants.get(pid)?.socketId !== socket.id || !room.canManage(pid)) {
        throw new Error('Session is no longer active');
      }
      room.setPack(loaded);
      return { stats: loaded.pack.stats };
    });

    on<{ link: string }>('steam:download', 'manager', ({ link }, pid) => {
      downloadWorkshopPack(link, (progress) => emitToManagers('steam:progress', { link, ...progress }),
        () => room.participants.get(pid)?.socketId === socket.id && room.canManage(pid))
        .then(async (result) => {
          emitToManagers('steam:progress', {
            link,
            stage: 'done',
            message: `Downloaded "${result.title}"`,
            file: result.file,
            percent: 100,
          });
          emitToManagers('packs:changed', { packs: await listPacks() });
        })
        .catch((err: Error) => emitToManagers('steam:progress', { link, stage: 'error', message: err.message }));
      return { started: true };
    });

    /* ---- game flow ---- */

    on('game:start', 'manager', () => room.engine.start());
    on('game:stop', 'moderator', () => room.engine.stop());
    on('game:pause', 'moderator', () => room.engine.pause());
    on('game:resume', 'moderator', () => room.engine.resume());
    on<{ themeIndex: number; questionIndex: number }>('game:select', 'member', ({ themeIndex, questionIndex }, pid) =>
      room.engine.selectQuestion(pid, room.canModerate(pid), Number(themeIndex), Number(questionIndex)),
    );
    on<{ themeIndex: number }>('game:removeFinalTheme', 'member', ({ themeIndex }, pid) =>
      room.engine.removeFinalTheme(pid, room.canModerate(pid), Number(themeIndex)));
    on<{ playerId: string; price: number }>('game:configureSpecial', 'moderator', ({ playerId, price }) =>
      room.engine.configureSpecial(playerId, Number(price)));
    on<{ amount: number; allIn: boolean }>('game:stakeBid', 'member', ({ amount, allIn }, pid) =>
      room.engine.bidStake(pid, amount, allIn));
    on('game:stakePass', 'member', (_, pid) => room.engine.passStake(pid));
    on<{ answer: string }>('game:forAllAnswer', 'member', ({ answer }, pid) =>
      room.engine.submitForAllAnswer(pid, answer));
    on<{ answer: string }>('game:answer', 'member', ({ answer }, pid) =>
      room.engine.submitAnswer(pid, answer));
    on('game:closeForAll', 'moderator', () => room.engine.closeForAllAnswers());
    on<{ playerId: string; correct: boolean }>('game:judgeForAll', 'moderator', ({ playerId, correct }) =>
      room.engine.judgeForAll(playerId, requireBoolean(correct)));
    on<{ amount: number }>('game:finalWager', 'member', ({ amount }, pid) =>
      room.engine.setFinalWager(pid, Number(amount)));
    on<{ answer: string }>('game:finalAnswer', 'member', ({ answer }, pid) =>
      room.engine.submitFinalAnswer(pid, answer));
    on('game:openFinal', 'moderator', () => room.engine.openFinal());
    on('game:closeFinal', 'moderator', () => room.engine.closeFinal());
    on<{ playerId: string; correct: boolean }>('game:judgeFinal', 'moderator', ({ playerId, correct }) =>
      room.engine.judgeFinal(playerId, requireBoolean(correct)));
    on('game:openBuzzer', 'moderator', () => room.engine.openBuzzer());
    on<{ presentationId: string }>('game:contentFinished', 'moderator', ({ presentationId }) =>
      room.engine.contentFinished(presentationId));
    on<{ presentationId: string }>('game:questionReady', 'member', ({ presentationId }, pid) =>
      room.engine.markQuestionReady(pid, String(presentationId ?? '')));
    on<{ clientAt?: number }>('game:buzz', 'member', (payload, pid) => {
      const buzzer = room.engine.buzzer;
      // Once this player's press is pending, penalized, or spent, repeats cannot improve it.
      if ((buzzer.blockedUntil.get(pid) ?? 0) > Date.now() || buzzer.attempted.has(pid) ||
          buzzer.pending.some((press) => press.playerId === pid)) return { result: 'ignored' };
      return room.engine.buzz(pid, payload);
    });
    on<{ correct: boolean; factor?: number }>('game:judge', 'moderator', ({ correct, factor }) =>
      room.engine.judge(requireBoolean(correct), factor === undefined ? 1 : Number(factor)));
    on<{ presentationId: string; judgmentId: number }>('game:undoJudgment', 'moderator',
      ({ presentationId, judgmentId }) => room.engine.undoJudgment(presentationId, judgmentId));
    on<{ judgmentId: number }>('game:appealRequest', 'member', ({ judgmentId }, pid) =>
      room.engine.requestAppeal(pid, judgmentId));
    on<{ support: boolean }>('game:appealVote', 'member', ({ support }, pid) =>
      room.engine.voteAppeal(pid, requireBoolean(support)));
    on('game:appealClose', 'moderator', () => room.engine.resolveAppeal());
    on('game:reveal', 'moderator', () => room.engine.revealAnswer());
    on('game:next', 'moderator', () => room.engine.next());
    on('game:prevRound', 'moderator', () => room.engine.prevRound());
    on('game:nextRound', 'moderator', () => room.engine.nextRound());

    socket.on('disconnect', () => {
      limits.disconnected(socket);
      if (socket.data.pid) room.detach(socket.data.pid as string, socket.id);
    });
  });
}

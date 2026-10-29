/**
 * Socket.io transport: maps client events to Room / GameEngine calls.
 */
import type { Server, Socket } from 'socket.io';
import { PHASES, type Role } from '../game/constants.ts';
import type { Participant, Room } from '../game/Room.ts';
import { SETTINGS_SCHEMA } from '../game/settings.ts';
import { listPacks, loadPack } from '../packs/packManager.ts';
import { downloadWorkshopPack } from '../steam/workshop.ts';

const JOINED_ROOM = 'joined';

type AccessLevel = 'none' | 'member' | 'moderator' | 'manager';
type AckCallback = (res: Record<string, unknown>) => void;

export function registerSocketHandlers(io: Server, room: Room): void {
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
    if (s) s.data.pid = null;
  });

  const emitToManagers = (event: string, payload: unknown): void => {
    for (const p of room.participants.values()) {
      if (p.socketId && room.canManage(p.id)) io.to(p.socketId).emit(event, payload);
    }
  };

  /* ------------------------------------------------------ per connection */

  io.on('connection', (socket: Socket) => {
    socket.data.pid = null as string | null;

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
          const pid = socket.data.pid as string | null;
          if (access !== 'none' && !pid) throw new Error('Join the game first');
          if (access !== 'none' && room.participants.get(pid!)?.socketId !== socket.id) {
            throw new Error('Session is no longer active');
          }
          if (access === 'moderator' && !room.canModerate(pid)) throw new Error('Only the host can do that');
          if (access === 'manager' && !room.canManage(pid)) throw new Error('Only the host or owner can do that');
          const result = await handler((payload ?? ({} as TPayload)), pid ?? '');
          if (event.startsWith('game:')) room.changed();
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
    };

    /* ---- clock sync ---- */

    on('clock:ping', 'none', () => ({ serverTime: Date.now() }));

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
      const { participant, token } = room.join(nickname, asSpectator === true);
      bind(participant);
      return { token, role: participant.role };
    });

    on('session:leave', 'member', (_, pid) => {
      room.remove(pid);
      socket.data.pid = null;
      socket.leave(JOINED_ROOM);
    });

    /* ---- roles ---- */

    on<{ role: Role }>('role:choose', 'member', ({ role }, pid) => room.chooseInitialRole(pid, role));
    on<{ targetId?: string; role: Role }>('role:set', 'member', ({ targetId, role }, pid) =>
      room.setRole(pid, targetId ?? pid, role),
    );
    on<{ targetId: string }>('participant:kick', 'moderator', ({ targetId }, pid) => room.kick(pid, targetId));
    on<{ targetId: string; delta: number }>('score:adjust', 'moderator', ({ targetId, delta }, pid) =>
      room.adjustScore(pid, targetId, Number(delta)),
    );

    /* ---- settings & packs ---- */

    on('settings:schema', 'none', () => ({ schema: SETTINGS_SCHEMA }));
    on<Record<string, unknown>>('settings:update', 'manager', (patch, pid) => room.updateSettings(pid, patch));

    on('packs:list', 'manager', async () => ({ packs: await listPacks() }));

    on<{ file: string }>('packs:load', 'manager', async ({ file }) => {
      if (room.engine.phase !== PHASES.LOBBY) throw new Error('Stop the current game before changing the pack');
      const loaded = await loadPack(file);
      room.setPack(loaded);
      return { stats: loaded.pack.stats };
    });

    on<{ link: string }>('steam:download', 'manager', ({ link }) => {
      downloadWorkshopPack(link, (progress) => emitToManagers('steam:progress', { link, ...progress }))
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
    on('game:closeForAll', 'moderator', () => room.engine.closeForAllAnswers());
    on<{ playerId: string; correct: boolean }>('game:judgeForAll', 'moderator', ({ playerId, correct }) =>
      room.engine.judgeForAll(playerId, correct));
    on<{ amount: number }>('game:finalWager', 'member', ({ amount }, pid) =>
      room.engine.setFinalWager(pid, Number(amount)));
    on('game:openFinal', 'moderator', () => room.engine.openFinal());
    on('game:closeFinal', 'moderator', () => room.engine.closeFinal());
    on<{ playerId: string; correct: boolean }>('game:judgeFinal', 'moderator', ({ playerId, correct }) =>
      room.engine.judgeFinal(playerId, correct === true));
    on('game:openBuzzer', 'moderator', () => room.engine.openBuzzer());
    on<{ clientAt?: number }>('game:buzz', 'member', (payload, pid) => room.engine.buzz(pid, payload));
    on<{ correct: boolean }>('game:judge', 'moderator', ({ correct }) => room.engine.judge(!!correct));
    on<{ judgmentId: number }>('game:appealRequest', 'member', ({ judgmentId }, pid) =>
      room.engine.requestAppeal(pid, judgmentId));
    on<{ support: boolean }>('game:appealVote', 'member', ({ support }, pid) =>
      room.engine.voteAppeal(pid, support));
    on('game:appealClose', 'moderator', () => room.engine.resolveAppeal());
    on('game:reveal', 'moderator', () => room.engine.revealAnswer());
    on('game:next', 'moderator', () => room.engine.next());
    on('game:prevRound', 'moderator', () => room.engine.prevRound());
    on('game:nextRound', 'moderator', () => room.engine.nextRound());

    socket.on('disconnect', () => {
      if (socket.data.pid) room.detach(socket.data.pid as string, socket.id);
    });
  });
}

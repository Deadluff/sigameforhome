/**
 * Socket.io transport: maps client events to Room / GameEngine calls.
 *
 * Conventions
 *  - every client → server event takes (payload, ack) and acks { ok: true, ...data } or { ok: false, error }
 *  - server → client:
 *      'room:state'     personalised snapshot (after every change)
 *      'game:event'     transient events for sounds/animations
 *      'steam:progress' workshop download progress (managers only)
 *      'packs:changed'  the packs folder content changed
 *      'session:kicked' you were removed by the host
 */
import { PHASES } from '../game/constants.js';
import { SETTINGS_SCHEMA } from '../game/settings.js';
import { listPacks, loadPack } from '../packs/packManager.js';
import { downloadWorkshopPack } from '../steam/workshop.js';

const JOINED_ROOM = 'joined';

/**
 * @param {import('socket.io').Server} io
 * @param {import('../game/Room.js').Room} room
 */
export function registerSocketHandlers(io, room) {
  /* ---------------------------------------------- room → clients fan-out */

  room.on('change', () => {
    for (const p of room.participants.values()) {
      if (p.socketId) io.to(p.socketId).emit('room:state', room.snapshotFor(p.id));
    }
  });

  room.on('event', (evt) => io.to(JOINED_ROOM).emit('game:event', evt));

  room.on('kicked', (p) => {
    if (!p.socketId) return;
    const s = io.sockets.sockets.get(p.socketId);
    s?.emit('session:kicked');
    s?.leave(JOINED_ROOM);
    if (s) s.data.pid = null;
  });

  const emitToManagers = (event, payload) => {
    for (const p of room.participants.values()) {
      if (p.socketId && room.canManage(p.id)) io.to(p.socketId).emit(event, payload);
    }
  };

  /* ------------------------------------------------------ per connection */

  io.on('connection', (socket) => {
    socket.data.pid = null;

    /**
     * Registers a handler with uniform error handling and permission checks.
     * @param {string} event
     * @param {'none'|'member'|'moderator'|'manager'} access
     * @param {(payload: any, pid: string|null) => any} handler  return value is merged into the ack
     */
    const on = (event, access, handler) => {
      socket.on(event, async (payload, ack) => {
        if (typeof payload === 'function') [payload, ack] = [undefined, payload];
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          const pid = socket.data.pid;
          if (access !== 'none' && !pid) throw new Error('Join the game first');
          if (access !== 'none' && room.participants.get(pid)?.socketId !== socket.id) {
            throw new Error('Session is no longer active');
          }
          if (access === 'moderator' && !room.canModerate(pid)) throw new Error('Only the host can do that');
          if (access === 'manager' && !room.canManage(pid)) throw new Error('Only the host or owner can do that');
          const result = await handler(payload ?? {}, pid);
          // Engine mutations don't notify by themselves (the engine is called synchronously),
          // so broadcast after every successful game action.
          if (event.startsWith('game:')) room.changed();
          reply({ ok: true, ...(result ?? {}) });
        } catch (err) {
          reply({ ok: false, error: err.message });
        }
      });
    };

    const bind = (participant) => {
      const stale = room.attach(participant.id, socket.id);
      if (stale) io.sockets.sockets.get(stale)?.disconnect(true); // same user opened a new tab/device
      socket.data.pid = participant.id;
      socket.join(JOINED_ROOM);
    };

    /* ---- session ---- */

    on('session:resume', 'none', ({ token }) => {
      if (socket.data.pid) throw new Error('Already joined');
      const participant = room.resume(token);
      if (!participant) return { resumed: false };
      bind(participant);
      return { resumed: true };
    });

    on('session:join', 'none', ({ nickname, asSpectator }) => {
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

    on('role:choose', 'member', ({ role }, pid) => room.chooseInitialRole(pid, role));
    on('role:set', 'member', ({ targetId, role }, pid) => room.setRole(pid, targetId ?? pid, role));
    on('participant:kick', 'moderator', ({ targetId }, pid) => room.kick(pid, targetId));
    on('score:adjust', 'moderator', ({ targetId, delta }, pid) => room.adjustScore(pid, targetId, Number(delta)));

    /* ---- settings & packs ---- */

    on('settings:schema', 'none', () => ({ schema: SETTINGS_SCHEMA }));
    on('settings:update', 'manager', (patch, pid) => room.updateSettings(pid, patch));

    on('packs:list', 'manager', async () => ({ packs: await listPacks() }));

    on('packs:load', 'manager', async ({ file }) => {
      if (room.engine.phase !== PHASES.LOBBY) throw new Error('Stop the current game before changing the pack');
      const loaded = await loadPack(file);
      room.setPack(loaded);
      return { stats: loaded.pack.stats };
    });

    on('steam:download', 'manager', ({ link }) => {
      // Long-running: ack immediately, report progress via events.
      downloadWorkshopPack(link, (progress) => emitToManagers('steam:progress', { link, ...progress }))
        .then(async (result) => {
          emitToManagers('steam:progress', { link, stage: 'done', message: `Downloaded "${result.title}"`, file: result.file, percent: 100 });
          emitToManagers('packs:changed', { packs: await listPacks() });
        })
        .catch((err) => emitToManagers('steam:progress', { link, stage: 'error', message: err.message }));
      return { started: true };
    });

    /* ---- game flow ---- */

    on('game:start', 'manager', () => room.engine.start());
    on('game:stop', 'moderator', () => room.engine.stop());
    on('game:pause', 'moderator', () => room.engine.pause());
    on('game:resume', 'moderator', () => room.engine.resume());
    on('game:select', 'member', ({ themeIndex, questionIndex }, pid) =>
      room.engine.selectQuestion(pid, room.canModerate(pid), Number(themeIndex), Number(questionIndex)),
    );
    on('game:removeFinalTheme', 'member', ({ themeIndex }, pid) =>
      room.engine.removeFinalTheme(pid, room.canModerate(pid), Number(themeIndex)));
    on('game:configureSpecial', 'moderator', ({ playerId, price }) =>
      room.engine.configureSpecial(playerId, Number(price)));
    on('game:stakeBid', 'member', ({ amount, allIn }, pid) => room.engine.bidStake(pid, amount, allIn));
    on('game:stakePass', 'member', (_, pid) => room.engine.passStake(pid));
    on('game:forAllAnswer', 'member', ({ answer }, pid) => room.engine.submitForAllAnswer(pid, answer));
    on('game:closeForAll', 'moderator', () => room.engine.closeForAllAnswers());
    on('game:judgeForAll', 'moderator', ({ playerId, correct }) => room.engine.judgeForAll(playerId, correct));
    on('game:finalWager', 'member', ({ amount }, pid) => room.engine.setFinalWager(pid, Number(amount)));
    on('game:openFinal', 'moderator', () => room.engine.openFinal());
    on('game:closeFinal', 'moderator', () => room.engine.closeFinal());
    on('game:judgeFinal', 'moderator', ({ playerId, correct }) => room.engine.judgeFinal(playerId, correct === true));
    on('game:openBuzzer', 'moderator', () => room.engine.openBuzzer());
    on('game:buzz', 'member', (_, pid) => room.engine.buzz(pid));
    on('game:judge', 'moderator', ({ correct }) => room.engine.judge(!!correct));
    on('game:appealRequest', 'member', ({ judgmentId }, pid) =>
      room.engine.requestAppeal(pid, judgmentId));
    on('game:appealVote', 'member', ({ support }, pid) =>
      room.engine.voteAppeal(pid, support));
    on('game:appealClose', 'moderator', () => room.engine.resolveAppeal());
    on('game:reveal', 'moderator', () => room.engine.revealAnswer());
    on('game:next', 'moderator', () => room.engine.next());
    on('game:nextRound', 'moderator', () => room.engine.nextRound());

    socket.on('disconnect', () => {
      if (socket.data.pid) room.detach(socket.data.pid, socket.id);
    });
  });
}

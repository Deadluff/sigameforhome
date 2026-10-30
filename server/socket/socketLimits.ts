/**
 * Caps sockets that have not joined the game, per address (audit SEC-10).
 *
 * A socket costs memory and a handshake before it joins, and nothing else bounded them, so one
 * device could open thousands. Joined sockets are already bounded by the room's participant
 * limit, so only unjoined ones count. Loopback is exempt: the Vite dev proxy, *.localhost
 * playtests and test bots all arrive from 127.0.0.1.
 *
 * Each socket carries `data.unjoined`. The address count changes only when that flag flips, so
 * a disconnect after a join, a leave, or a kick can never double-count.
 */
import type { Socket } from 'socket.io';

type LimitedSocket = Pick<Socket, 'handshake' | 'data'>;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createSocketLimits(cap = Number(process.env.SOCKET_CAP_PER_ADDRESS ?? 32)) {
  const counts = new Map<string, number>();
  const addressOf = (socket: LimitedSocket) => socket.handshake?.address ?? '';
  const tracked = (socket: LimitedSocket) => !LOOPBACK.has(addressOf(socket));
  const change = (socket: LimitedSocket, delta: number) => {
    const address = addressOf(socket);
    const next = (counts.get(address) ?? 0) + delta;
    if (next > 0) counts.set(address, next);
    else counts.delete(address);
  };
  const mark = (socket: LimitedSocket, unjoined: boolean) => {
    if (!tracked(socket) || Boolean(socket.data.unjoined) === unjoined) return;
    socket.data.unjoined = unjoined;
    change(socket, unjoined ? 1 : -1);
  };

  return {
    /**
     * Socket.IO middleware: refuse a new socket when its address is at the cap. It only checks;
     * counting starts on `connection`, because Socket.IO drops a socket whose transport closed
     * during the handshake without ever emitting `connection` or `disconnect`, and a count taken
     * here would never be returned. Sockets admitted in the same tick may pass the cap by a few.
     */
    middleware(socket: LimitedSocket, next: (err?: Error) => void): void {
      if (tracked(socket) && (counts.get(addressOf(socket)) ?? 0) >= cap) {
        next(new Error('Too many open connections from this device'));
        return;
      }
      next();
    },
    /** The socket is connected and has not joined yet. */
    connected(socket: LimitedSocket) { mark(socket, true); },
    /** The socket joined or resumed a seat. */
    joined(socket: LimitedSocket) { mark(socket, false); },
    /** The socket left or was kicked but stays connected. */
    left(socket: LimitedSocket) { mark(socket, true); },
    disconnected(socket: LimitedSocket) { mark(socket, false); },
    count(address: string) { return counts.get(address) ?? 0; },
  };
}

export type SocketLimits = ReturnType<typeof createSocketLimits>;

import { io, Socket } from 'socket.io-client';
import { getSession, subscribeSession } from './session';

let socket: Socket | null = null;
let lastStoreId: string | null = null;
let lastToken: string | null = null;

/**
 * Returns a singleton Socket.IO connection wired to the current session.
 * The connection is rebuilt if the active store or access token changes
 * (e.g. after login / logout / store-switch) so we never reuse a socket
 * authed for a different tenant.
 */
export function getSocket(): Socket {
  const session = getSession();
  const storeId = session.user?.storeId ?? null;
  const token = session.accessToken;
  const registerId = session.registerId ?? undefined;

  if (socket && (storeId !== lastStoreId || token !== lastToken)) {
    socket.disconnect();
    socket = null;
  }

  if (!socket) {
    const url = import.meta.env.VITE_API_URL ?? '';
    const auth: Record<string, string> = token
      ? { token, ...(registerId ? { registerId } : {}) }
      : storeId
        ? { storeId, ...(registerId ? { registerId } : {}) }
        : {};
    socket = io(url, { transports: ['websocket'], auth, autoConnect: true });
    lastStoreId = storeId;
    lastToken = token;
  }
  return socket;
}

/** Drop the current socket on session change so the next caller rebuilds it. */
subscribeSession(() => {
  const session = getSession();
  if (
    socket &&
    (session.user?.storeId !== lastStoreId || session.accessToken !== lastToken)
  ) {
    socket.disconnect();
    socket = null;
  }
});

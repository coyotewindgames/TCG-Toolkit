import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const url = import.meta.env.VITE_API_URL ?? '';
    const token = localStorage.getItem('tcg.token');
    const storeId = import.meta.env.VITE_STORE_ID ?? 'store-1';
    const registerId = import.meta.env.VITE_REGISTER_ID;
    const auth: Record<string, string> = token
      ? { token }
      : { storeId, ...(registerId ? { registerId } : {}) };
    socket = io(url, {
      transports: ['websocket'],
      auth,
      autoConnect: true,
    });
  }
  return socket;
}

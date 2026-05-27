import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const url = import.meta.env.VITE_API_URL ?? '';
    socket = io(url, {
      transports: ['websocket'],
      auth: { token: localStorage.getItem('tcg.token') ?? 'dev' },
      autoConnect: true,
    });
  }
  return socket;
}

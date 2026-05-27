import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { SOCKET_EVENTS } from '@tcg/shared';
import { loadEnv, isProd } from '../../config/env';
import { duplicateRedis } from '../redis';
import { verifyAccessToken, type JwtClaims } from '../auth/service';

interface HandshakeAuth {
  token?: string;
  storeId?: string;
  registerId?: string;
}

let io: Server | null = null;

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO server not initialized');
  return io;
}

export async function initRealtime(http: HttpServer): Promise<Server> {
  const env = loadEnv();
  const corsOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  const allowAny = corsOrigins.includes('*');
  io = new Server(http, {
    cors: {
      origin: allowAny ? true : corsOrigins,
      credentials: !allowAny,
    },
    serveClient: false,
  });

  // Attach Redis adapter for horizontal scaling.
  try {
    const pub = duplicateRedis();
    const sub = duplicateRedis();
    io.adapter(createAdapter(pub, sub));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[socket.io] redis adapter unavailable, falling back to memory', err);
  }

  io.use((socket, next) => {
    const auth = socket.handshake.auth as HandshakeAuth;
    // Dev shortcut: skip JWT in non-prod when only storeId is provided.
    if (!isProd() && auth?.storeId && !auth.token) {
      socket.data.storeId = auth.storeId;
      socket.data.registerId = auth.registerId ?? null;
      return next();
    }
    if (!auth?.token) return next(new Error('missing token'));
    try {
      const claims: JwtClaims = verifyAccessToken(auth.token);
      socket.data.userId = claims.sub;
      socket.data.storeId = claims.sid;
      socket.data.role = claims.role;
      socket.data.registerId = auth.registerId ?? null;
      if (auth.storeId && auth.storeId !== claims.sid) {
        return next(new Error('store mismatch'));
      }
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', (socket: Socket) => {
    const { storeId, registerId } = socket.data as { storeId: string; registerId: string | null };
    socket.join(`store:${storeId}`);
    if (registerId) socket.join(`register:${storeId}:${registerId}`);

    socket.on('order.join', (msg: { orderId?: string }) => {
      if (msg?.orderId) socket.join(`order:${msg.orderId}`);
    });
  });

  return io;
}

// ---- emit helpers used by services ----

export function emitToStore(storeId: string, event: string, payload: unknown): void {
  io?.to(`store:${storeId}`).emit(event, payload);
}

export function emitToRegister(
  storeId: string,
  registerId: string,
  event: string,
  payload: unknown,
): void {
  io?.to(`register:${storeId}:${registerId}`).emit(event, payload);
}

export function emitToOrder(orderId: string, event: string, payload: unknown): void {
  io?.to(`order:${orderId}`).emit(event, payload);
}

export { SOCKET_EVENTS };

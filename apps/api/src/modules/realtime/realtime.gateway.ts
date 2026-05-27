import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, Injectable } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '@tcg/shared';

interface SocketHandshakeAuth {
  token?: string;
  storeId?: string;
  registerId?: string;
}

/**
 * Single Socket.IO gateway with rooms:
 *   `store:{storeId}`           — store-wide broadcasts (inventory, pricing)
 *   `register:{storeId}:{regId}` — per-register cart events
 *   `order:{orderId}`           — per-order checkout updates
 *
 * Horizontal scaling: attach the Redis adapter in `main.ts` once
 * multiple API instances are deployed.
 */
@Injectable()
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? true, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  async handleConnection(client: Socket) {
    const auth = client.handshake.auth as SocketHandshakeAuth;
    // TODO: verify JWT (auth.token). Reject if invalid.
    if (!auth?.storeId) {
      this.logger.warn(`socket ${client.id} missing storeId; disconnecting`);
      client.disconnect(true);
      return;
    }
    client.data.storeId = auth.storeId;
    client.join(`store:${auth.storeId}`);
    if (auth.registerId) {
      client.join(`register:${auth.storeId}:${auth.registerId}`);
    }
    this.logger.log(`socket ${client.id} joined store:${auth.storeId}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`socket ${client.id} disconnected`);
  }

  // ---- Emit helpers (called from services) ----

  emitToStore(storeId: string, event: string, payload: unknown) {
    this.server.to(`store:${storeId}`).emit(event, payload);
  }

  emitToRegister(storeId: string, registerId: string, event: string, payload: unknown) {
    this.server.to(`register:${storeId}:${registerId}`).emit(event, payload);
  }

  emitToOrder(orderId: string, event: string, payload: unknown) {
    this.server.to(`order:${orderId}`).emit(event, payload);
  }

  joinOrderRoom(socketId: string, orderId: string) {
    const sock = this.server.sockets.sockets.get(socketId);
    sock?.join(`order:${orderId}`);
  }
}

export { SOCKET_EVENTS };

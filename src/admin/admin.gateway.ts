import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger, OnModuleDestroy } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import { Server, Socket } from "socket.io";
import { AdminAuthService } from "./admin-auth.service";

@WebSocketGateway({
  cors: { origin: "*" },
  namespace: "/admin",
})
export class AdminGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AdminGateway.name);
  private changeStreams: { close: () => void }[] = [];

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly authService: AdminAuthService,
  ) {}

  afterInit() {
    this.logger.log("Admin WebSocket gateway initialized");
    this.watchCollections();
  }

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token;
    if (!token) {
      this.logger.warn("WebSocket connection without token — disconnecting");
      client.disconnect(true);
      return;
    }
    try {
      this.authService.verifyToken(token);
      this.logger.log(`Admin client connected: ${client.id}`);
    } catch {
      this.logger.warn("WebSocket connection with invalid token — disconnecting");
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Admin client disconnected: ${client.id}`);
  }

  onModuleDestroy() {
    for (const cs of this.changeStreams) {
      try { cs.close(); } catch {}
    }
  }

  private watchCollections() {
    this.watchCollection("ai_signals", "signal");
    this.watchCollection("user_trades", "trade");
    this.watchCollection("user_signal_subscriptions", "user");
  }

  private watchCollection(collectionName: string, eventPrefix: string) {
    try {
      const collection = this.connection.collection(collectionName);
      const changeStream = collection.watch([], { fullDocument: "updateLookup" });

      changeStream.on("change", (change: Record<string, unknown>) => {
        const opType = change.operationType as string;
        const doc = (change as Record<string, unknown>).fullDocument;

        if (opType === "insert") {
          this.server.emit(`${eventPrefix}:created`, doc);
        } else if (opType === "update" || opType === "replace") {
          this.server.emit(`${eventPrefix}:updated`, doc);
        } else if (opType === "delete") {
          const docKey = change.documentKey as { _id: unknown } | undefined;
          this.server.emit(`${eventPrefix}:deleted`, {
            _id: docKey?._id,
          });
        }
      });

      changeStream.on("error", (err: Error) => {
        this.logger.warn(`Change stream error for ${collectionName}: ${err.message}`);
      });

      this.changeStreams.push(changeStream as unknown as { close: () => void });
      this.logger.log(`Watching ${collectionName} for changes`);
    } catch (err) {
      this.logger.warn(
        `Could not watch ${collectionName} (requires MongoDB replica set): ${(err as Error).message}`,
      );
    }
  }
}

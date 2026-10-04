import { DurableObject } from 'cloudflare:workers';

/**
 * Live updates: one hibernating Durable Object holds every open browser WebSocket for this
 * instance. It only relays "something changed" pings; it stores nothing and never reads data.
 * Each socket carries the channels the worker authorized it for (tags), and a ping goes to the
 * sockets with that tag. Pages then refetch through the normal, permission-checked API.
 */
export class LiveHub extends DurableObject<CloudflareBindings> {
  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  /** Accepts a socket the worker already authenticated, subscribed to `X-Live-Channels`. */
  async fetch(request: Request): Promise<Response> {
    const channels = (request.headers.get('X-Live-Channels') ?? '')
      .split(',')
      .filter(Boolean);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], channels);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Sends a ping to every socket subscribed to `channel`. */
  async publish(channel: string, message: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(channel)) {
      try {
        ws.send(message);
      } catch {
        // Closing; the browser reconnects.
      }
    }
  }

  async webSocketMessage() {
    // Clients only send keepalives, answered by the auto-response.
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      // Already closed.
    }
  }
}

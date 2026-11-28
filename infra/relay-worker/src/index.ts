import {
  AUTH_HASH_PATTERN,
  PEER_ID_PATTERN,
  RELAY_PROTOCOL_VERSION,
  ROOM_ID_PATTERN,
  decodeRelayRoutedFrame,
  encodeRelayRoutedFrame,
  timingSafeEqualAscii,
} from "./protocol.ts";

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface CloudflareWebSocket extends WebSocket {
  accept(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface DurableObjectState {
  acceptWebSocket(ws: WebSocket, tags?: ReadonlyArray<string>): void;
  getWebSockets(tag?: string): Array<CloudflareWebSocket>;
  setWebSocketAutoResponse(pair: unknown): void;
}

declare class WebSocketPair {
  readonly 0: CloudflareWebSocket;
  readonly 1: CloudflareWebSocket;
}

declare const WebSocketRequestResponsePair: {
  new (request: string, response: string): unknown;
};

export interface RelayEnv {
  readonly RELAY_ROOM: DurableObjectNamespace;
  readonly RELAY_ACCESS_TOKEN?: string;
  readonly MAX_VIEWERS_PER_ROOM?: string;
  readonly MAX_FRAME_BYTES?: string;
}

interface SocketAttachment {
  readonly role: "host" | "viewer";
  readonly peerId: string;
  readonly authHash: string;
  readonly connectedAt: number;
}

const DEFAULT_MAX_VIEWERS_PER_ROOM = 4;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-Relay-Token, Content-Type",
};

function withCors(headers: Headers): Headers {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors(
      new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      }),
    ),
  });
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extractAccessToken(request: Request, url: URL): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) return token;
  }
  const headerToken = request.headers.get("X-Relay-Token")?.trim();
  if (headerToken) return headerToken;
  const queryToken = url.searchParams.get("token")?.trim();
  if (queryToken) return queryToken;
  return null;
}

function checkOperatorAccessToken(request: Request, url: URL, env: RelayEnv): boolean {
  const expected = env.RELAY_ACCESS_TOKEN?.trim();
  if (!expected) return true;
  const provided = extractAccessToken(request, url);
  if (!provided) return false;
  return timingSafeEqualAscii(provided, expected);
}

function safeSendText(ws: CloudflareWebSocket, payload: object): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Socket may already be closing.
  }
}

function safeSendBinary(ws: CloudflareWebSocket, payload: Uint8Array): void {
  try {
    ws.send(payload);
  } catch {
    // Socket may already be closing.
  }
}

/**
 * Zero-knowledge E2EE Durable Object room (inspired by yetone/alma-relay).
 * Routes opaque encrypted binary frames between one Host and up to N Viewers
 * using WebSocket Hibernation so idle connections consume near-zero resources.
 */
export class RelayRoom {
  private readonly ctx: DurableObjectState;
  private readonly env: RelayEnv;

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private getHostSocket(): CloudflareWebSocket | null {
    const hosts = this.ctx.getWebSockets("host");
    return hosts[0] ?? null;
  }

  private getViewerSockets(): Array<CloudflareWebSocket> {
    return this.ctx.getWebSockets("viewer");
  }

  private readAttachment(ws: CloudflareWebSocket): SocketAttachment | null {
    const raw = ws.deserializeAttachment();
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Partial<SocketAttachment>;
    if (
      (record.role === "host" || record.role === "viewer") &&
      typeof record.peerId === "string" &&
      typeof record.authHash === "string"
    ) {
      return {
        role: record.role,
        peerId: record.peerId,
        authHash: record.authHash,
        connectedAt: typeof record.connectedAt === "number" ? record.connectedAt : 0,
      };
    }
    return null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/status")) {
      const host = this.getHostSocket();
      const viewers = this.getViewerSockets();
      return jsonResponse({
        ok: true,
        protocolVersion: RELAY_PROTOCOL_VERSION,
        hostOnline: host !== null,
        viewerCount: viewers.length,
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Expected WebSocket upgrade" }, 426);
    }

    const role = url.searchParams.get("role");
    const authHash = url.searchParams.get("auth")?.trim() ?? "";
    const peerIdParam = url.searchParams.get("peerId")?.trim() ?? "";

    if (role !== "host" && role !== "viewer") {
      return jsonResponse({ error: "Invalid role; expected host or viewer" }, 400);
    }
    if (!AUTH_HASH_PATTERN.test(authHash)) {
      return jsonResponse({ error: "Missing or invalid room auth hash" }, 400);
    }

    const peerId = role === "host" ? "host" : peerIdParam;
    if (role === "viewer" && !PEER_ID_PATTERN.test(peerId)) {
      return jsonResponse({ error: "Missing or invalid viewer peerId" }, 400);
    }

    const existingHost = this.getHostSocket();
    const existingHostAttachment = existingHost ? this.readAttachment(existingHost) : null;

    if (role === "viewer") {
      const maxViewers = parsePositiveInt(
        this.env.MAX_VIEWERS_PER_ROOM,
        DEFAULT_MAX_VIEWERS_PER_ROOM,
      );
      const viewers = this.getViewerSockets();
      const duplicateViewer = viewers.find(
        (candidate) => this.readAttachment(candidate)?.peerId === peerId,
      );
      if (!duplicateViewer && viewers.length >= maxViewers) {
        return jsonResponse({ error: "Room viewer capacity reached" }, 429);
      }
      if (
        existingHostAttachment &&
        !timingSafeEqualAscii(existingHostAttachment.authHash, authHash)
      ) {
        return jsonResponse({ error: "Room authentication failed" }, 403);
      }
      if (duplicateViewer) {
        try {
          duplicateViewer.close(4002, "Replaced by duplicate viewer peerId");
        } catch {
          // Ignore close error on stale socket.
        }
      }
    } else if (existingHost) {
      if (
        existingHostAttachment &&
        !timingSafeEqualAscii(existingHostAttachment.authHash, authHash)
      ) {
        return jsonResponse({ error: "Room is already claimed with a different auth key" }, 403);
      }
      try {
        existingHost.close(4001, "Replaced by new host connection");
      } catch {
        // Ignore close error on stale host socket.
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const tags = role === "host" ? ["host"] : ["viewer", `peer:${peerId}`];

    this.ctx.acceptWebSocket(server, tags);
    server.serializeAttachment({
      role,
      peerId,
      authHash,
      connectedAt: Date.now(),
    } satisfies SocketAttachment);

    if (role === "host") {
      const viewers = this.getViewerSockets();
      // Drop any waiting viewer whose room auth hash doesn't match the host's key.
      const authorizedViewers: Array<{ ws: CloudflareWebSocket; peerId: string }> = [];
      for (const viewer of viewers) {
        const attachment = this.readAttachment(viewer);
        if (!attachment || !timingSafeEqualAscii(attachment.authHash, authHash)) {
          try {
            viewer.close(4003, "Room authentication mismatch");
          } catch {
            // Ignore.
          }
          continue;
        }
        authorizedViewers.push({ ws: viewer, peerId: attachment.peerId });
      }

      safeSendText(server, {
        type: "relay_ready",
        role: "host",
        protocolVersion: RELAY_PROTOCOL_VERSION,
        viewerIds: authorizedViewers.map((entry) => entry.peerId),
      });

      for (const entry of authorizedViewers) {
        safeSendText(entry.ws, {
          type: "host_status",
          online: true,
          peerId: entry.peerId,
        });
      }
    } else {
      const host = this.getHostSocket();
      safeSendText(server, {
        type: "relay_ready",
        role: "viewer",
        peerId,
        protocolVersion: RELAY_PROTOCOL_VERSION,
        hostOnline: host !== null,
      });

      if (host) {
        safeSendText(host, {
          type: "peer_joined",
          peerId,
          viewerCount: this.getViewerSockets().length,
        });
      }
    }

    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(ws: CloudflareWebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.readAttachment(ws);
    if (!attachment) {
      ws.close(1008, "Missing socket metadata");
      return;
    }

    if (typeof message === "string") {
      if (message === "ping") {
        ws.send("pong");
      }
      return;
    }

    const bytes = new Uint8Array(message);
    const maxFrameBytes = parsePositiveInt(this.env.MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_BYTES);
    if (bytes.byteLength > maxFrameBytes) {
      safeSendText(ws, {
        type: "error",
        code: "frame_too_large",
        message: `Frame exceeded maximum size of ${maxFrameBytes} bytes`,
      });
      return;
    }

    if (attachment.role === "viewer") {
      const host = this.getHostSocket();
      if (!host) {
        safeSendText(ws, { type: "host_status", online: false, peerId: attachment.peerId });
        return;
      }
      safeSendBinary(host, encodeRelayRoutedFrame(attachment.peerId, bytes));
      return;
    }

    // Host -> Viewer(s): Host prepends target peerId (or "*" for broadcast).
    const routed = decodeRelayRoutedFrame(bytes);
    if (!routed) {
      safeSendText(ws, {
        type: "error",
        code: "invalid_route_frame",
        message: "Malformed host routing envelope",
      });
      return;
    }

    if (routed.peerId === "*") {
      for (const viewer of this.getViewerSockets()) {
        safeSendBinary(viewer, routed.payload);
      }
      return;
    }

    const targets = this.ctx.getWebSockets(`peer:${routed.peerId}`);
    for (const target of targets) {
      safeSendBinary(target, routed.payload);
    }
  }

  async webSocketClose(ws: CloudflareWebSocket): Promise<void> {
    this.handleSocketDisconnect(ws);
  }

  async webSocketError(ws: CloudflareWebSocket): Promise<void> {
    this.handleSocketDisconnect(ws);
  }

  private handleSocketDisconnect(ws: CloudflareWebSocket): void {
    const attachment = this.readAttachment(ws);
    if (!attachment) return;

    if (attachment.role === "host") {
      // Only broadcast offline if no replacement host socket is already active.
      const remainingHosts = this.ctx.getWebSockets("host").filter((candidate) => candidate !== ws);
      if (remainingHosts.length === 0) {
        for (const viewer of this.getViewerSockets()) {
          const viewerMeta = this.readAttachment(viewer);
          safeSendText(viewer, {
            type: "host_status",
            online: false,
            peerId: viewerMeta?.peerId ?? "",
          });
        }
      }
      return;
    }

    const host = this.getHostSocket();
    if (host) {
      const remainingViewers = this.getViewerSockets().filter((candidate) => candidate !== ws);
      safeSendText(host, {
        type: "peer_left",
        peerId: attachment.peerId,
        viewerCount: remainingViewers.length,
      });
    }
  }
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: withCors(new Headers()) });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "tix-relay",
        protocolVersion: RELAY_PROTOCOL_VERSION,
        authRequired: Boolean(env.RELAY_ACCESS_TOKEN?.trim()),
      });
    }

    const roomMatch = /^\/r\/([a-f0-9]{32,128})\/(ws|status)$/i.exec(pathname);
    if (!roomMatch) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    const roomId = roomMatch[1]!.toLowerCase();
    if (!ROOM_ID_PATTERN.test(roomId)) {
      return jsonResponse({ error: "Invalid room id" }, 400);
    }

    if (!checkOperatorAccessToken(request, url, env)) {
      return jsonResponse({ error: "Unauthorized relay access token" }, 401);
    }

    const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(roomId));
    return stub.fetch(request);
  },
};

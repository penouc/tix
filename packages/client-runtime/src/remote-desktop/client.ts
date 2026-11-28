// @effect-diagnostics globalTimers:off globalDate:off -- Browser and WebView remote desktop client runs outside an Effect runtime.

import type {
  RemoteDesktopDisplay,
  RemoteDesktopInputEvent,
  RemoteDesktopQualityPreset,
  RemoteDesktopTransportKind,
} from "@t3tools/contracts";
import {
  REMOTE_DESKTOP_FRAME_TYPE,
  RemoteDesktopCryptoSession,
  createHandshakeState,
  deriveRemoteDesktopRelayIdentity,
  encodeHandshakeFrame,
  isHandshakeFrame,
  toRelayWebSocketUrl,
} from "@t3tools/shared/remoteDesktopCrypto";

export type RemoteDesktopClientStatus =
  | "connecting"
  | "handshaking"
  | "waiting_host"
  | "streaming"
  | "reconnecting"
  | "error"
  | "disconnected";

export interface RemoteDesktopSessionInfo {
  readonly displays: ReadonlyArray<RemoteDesktopDisplay>;
  readonly activeDisplayId: string;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly allowControl: boolean;
  readonly quality: RemoteDesktopQualityPreset;
  readonly maxFps: number;
  readonly codec: "h264" | "jpeg";
  readonly fingerprint: string;
}

export interface RemoteDesktopClientStats {
  readonly fps: number;
  readonly rttMs: number | null;
  readonly transport: RemoteDesktopTransportKind;
  readonly encrypted: boolean;
  readonly width: number;
  readonly height: number;
}

export interface RemoteDesktopClientConfig {
  /** Direct LAN/Tailscale ws(s)://... URL including ?ticket=...&peerId=... */
  readonly directWsUrl?: string | null;
  /** Custom Cloudflare Worker relay HTTP(S) base URL, e.g. https://relay.penglei.dev */
  readonly relayUrl?: string | null;
  readonly relayAccessToken?: string | null;
  /** 256-bit base64url master key for E2EE handshake & zero-knowledge relay routing. */
  readonly masterKey: string;
  /** Prefer direct LAN/Tailscale first, or force relay. */
  readonly transportPreference?: "auto" | "direct" | "relay";
}

export interface RemoteDesktopClientCallbacks {
  readonly onStatus: (status: RemoteDesktopClientStatus, detail?: string) => void;
  readonly onSessionInfo: (info: RemoteDesktopSessionInfo) => void;
  readonly onStats: (stats: RemoteDesktopClientStats) => void;
  readonly onCaptureError?: (message: string) => void;
}

export interface RemoteDesktopClientHandle {
  readonly sendInput: (event: RemoteDesktopInputEvent) => void;
  readonly setDisplay: (displayId: string) => void;
  readonly setQuality: (quality: RemoteDesktopQualityPreset, maxFps?: number) => void;
  readonly reconnect: (transport?: "auto" | "direct" | "relay") => void;
  readonly stop: () => void;
}

const textDecoder = new TextDecoder();

function randomPeerId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `v_${hex}`;
}

export function buildDirectRemoteDesktopWsUrl(
  httpOrWsOrigin: string,
  directWsPath: string,
  directTicket: string,
  peerId: string,
): string {
  const parsed = new URL(httpOrWsOrigin);
  parsed.protocol = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "wss:" : "ws:";
  parsed.pathname = directWsPath;
  parsed.search = "";
  parsed.hash = "";
  parsed.searchParams.set("ticket", directTicket);
  parsed.searchParams.set("peerId", peerId);
  return parsed.toString();
}

export function createRemoteDesktopClient(
  config: RemoteDesktopClientConfig,
  canvas: HTMLCanvasElement,
  callbacks: RemoteDesktopClientCallbacks,
): RemoteDesktopClientHandle {
  const identity = deriveRemoteDesktopRelayIdentity(config.masterKey);
  const peerId = randomPeerId();
  const ctx = canvas.getContext("2d");

  let stopped = false;
  let socket: WebSocket | null = null;
  let session: RemoteDesktopCryptoSession | null = null;
  let activeTransport: RemoteDesktopTransportKind = "direct";
  let preference: "auto" | "direct" | "relay" = config.transportPreference ?? "auto";
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let backoffMs = 1000;
  let directFailedOnce = false;
  let decodingFrame = false;
  let pendingJpeg: Uint8Array | null = null;
  let framesInWindow = 0;
  let latestRttMs: number | null = null;
  let frameWidth = 1920;
  let frameHeight = 1080;

  const clearTimers = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  };

  const isStopped = () => stopped;

  const renderJpegFrame = async (jpegBytes: Uint8Array) => {
    if (isStopped() || !ctx) return;
    if (decodingFrame) {
      pendingJpeg = jpegBytes;
      return;
    }
    decodingFrame = true;
    try {
      let next: Uint8Array | null = jpegBytes;
      while (next && !isStopped()) {
        const current = next;
        pendingJpeg = null;
        const copy = new Uint8Array(current.byteLength);
        copy.set(current);
        const blob = new Blob([copy], { type: "image/jpeg" });
        if (typeof globalThis.createImageBitmap === "function") {
          const bitmap = await globalThis.createImageBitmap(blob);
          try {
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              frameWidth = bitmap.width;
              frameHeight = bitmap.height;
            }
            ctx.drawImage(bitmap, 0, 0);
            framesInWindow += 1;
          } finally {
            bitmap.close();
          }
        } else {
          const objectUrl = URL.createObjectURL(blob);
          try {
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
              const el = new Image();
              el.onload = () => resolve(el);
              el.onerror = () => reject(new Error("Image decode failed"));
              el.src = objectUrl;
            });
            if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              frameWidth = img.naturalWidth;
              frameHeight = img.naturalHeight;
            }
            ctx.drawImage(img, 0, 0);
            framesInWindow += 1;
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        }
        next = pendingJpeg;
      }
    } catch {
      // Drop corrupt frame and wait for next.
    } finally {
      decodingFrame = false;
    }
  };

  const sendEncrypted = (
    frameType:
      | typeof REMOTE_DESKTOP_FRAME_TYPE.inputJson
      | typeof REMOTE_DESKTOP_FRAME_TYPE.controlJson
      | typeof REMOTE_DESKTOP_FRAME_TYPE.heartbeat,
    payload: unknown,
  ) => {
    const activeSession = session;
    const activeSocket = socket;
    if (!activeSession || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
    void activeSession
      .encryptJson(frameType, payload)
      .then((encrypted) => {
        if (socket === activeSocket && activeSocket.readyState === WebSocket.OPEN) {
          activeSocket.send(
            encrypted.buffer.slice(
              encrypted.byteOffset,
              encrypted.byteOffset + encrypted.byteLength,
            ) as ArrayBuffer,
          );
        }
      })
      .catch(() => {
        // Ignore send errors while reconnecting.
      });
  };

  const chooseEndpoint = (): {
    readonly transport: RemoteDesktopTransportKind;
    readonly url: string;
  } | null => {
    const hasDirect = Boolean(config.directWsUrl);
    const hasRelay = Boolean(config.relayUrl);

    if (preference === "relay" && hasRelay) {
      return {
        transport: "relay",
        url: toRelayWebSocketUrl(config.relayUrl!, identity.roomId, {
          role: "viewer",
          authHash: identity.roomAuthHash,
          peerId,
          ...(config.relayAccessToken ? { accessToken: config.relayAccessToken } : {}),
        }),
      };
    }

    if (preference === "direct" && hasDirect) {
      return { transport: "direct", url: config.directWsUrl! };
    }

    if (hasDirect && !directFailedOnce) {
      return { transport: "direct", url: config.directWsUrl! };
    }

    if (hasRelay) {
      return {
        transport: "relay",
        url: toRelayWebSocketUrl(config.relayUrl!, identity.roomId, {
          role: "viewer",
          authHash: identity.roomAuthHash,
          peerId,
          ...(config.relayAccessToken ? { accessToken: config.relayAccessToken } : {}),
        }),
      };
    }

    if (hasDirect) {
      return { transport: "direct", url: config.directWsUrl! };
    }

    return null;
  };

  const connect = () => {
    if (stopped) return;
    clearTimers();
    session = null;
    if (socket) {
      try {
        socket.close(1000, "Reconnecting");
      } catch {
        // Ignore.
      }
      socket = null;
    }

    const endpoint = chooseEndpoint();
    if (!endpoint) {
      callbacks.onStatus("error", "No direct endpoint or Cloudflare relay URL configured.");
      return;
    }

    activeTransport = endpoint.transport;
    callbacks.onStatus(
      "connecting",
      endpoint.transport === "relay"
        ? "Connecting via Cloudflare E2EE relay..."
        : "Connecting directly to host...",
    );

    const ws = new WebSocket(endpoint.url);
    ws.binaryType = "arraybuffer";
    socket = ws;

    let handshakeState = createHandshakeState("viewer", identity.roomId);
    let handshakeSent = false;

    const sendHandshake = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      handshakeState = createHandshakeState("viewer", identity.roomId);
      const initFrame = encodeHandshakeFrame(handshakeState, config.masterKey);
      ws.send(
        initFrame.buffer.slice(
          initFrame.byteOffset,
          initFrame.byteOffset + initFrame.byteLength,
        ) as ArrayBuffer,
      );
      handshakeSent = true;
      callbacks.onStatus("handshaking", "Negotiating X25519 E2EE session...");
    };

    const scheduleReconnect = (detail: string) => {
      if (stopped || socket !== ws) return;
      clearTimers();
      socket = null;
      session = null;
      if (endpoint.transport === "direct" && config.relayUrl && preference === "auto") {
        directFailedOnce = true;
        callbacks.onStatus(
          "reconnecting",
          "Direct route unavailable, switching to Cloudflare relay...",
        );
        reconnectTimer = setTimeout(connect, 250);
        return;
      }
      callbacks.onStatus("reconnecting", detail);
      const delay = backoffMs;
      backoffMs = Math.min(10_000, Math.round(backoffMs * 1.6));
      reconnectTimer = setTimeout(connect, delay);
    };

    ws.addEventListener("open", () => {
      if (stopped || socket !== ws) return;
      backoffMs = 1000;
      if (endpoint.transport === "direct") {
        sendHandshake();
      }
    });

    ws.addEventListener("message", (event) => {
      if (stopped || socket !== ws) return;

      if (typeof event.data === "string") {
        if (event.data === "pong") return;
        try {
          const msg = JSON.parse(event.data) as {
            readonly type?: string;
            readonly hostOnline?: boolean;
            readonly online?: boolean;
            readonly message?: string;
          };
          if (msg.type === "relay_ready") {
            if (msg.hostOnline) {
              sendHandshake();
            } else {
              callbacks.onStatus(
                "waiting_host",
                "Connected to relay. Waiting for host computer...",
              );
            }
          } else if (msg.type === "host_status") {
            if (msg.online) {
              session = null;
              sendHandshake();
            } else {
              session = null;
              callbacks.onStatus("waiting_host", "Host disconnected from relay. Waiting...");
            }
          } else if (msg.type === "error" && msg.message) {
            callbacks.onStatus("error", msg.message);
          }
        } catch {
          // Ignore malformed relay control JSON.
        }
        return;
      }

      const raw =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : ArrayBuffer.isView(event.data)
            ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
            : null;
      if (!raw) return;

      if (!session) {
        if (!handshakeSent || !isHandshakeFrame(raw)) return;
        void RemoteDesktopCryptoSession.establish({
          localState: handshakeState,
          peerHandshakeFrame: raw,
          masterKey: config.masterKey,
        })
          .then((established) => {
            if (stopped || socket !== ws) return;
            session = established;
            callbacks.onStatus("streaming");
            heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                if (activeTransport === "relay") {
                  try {
                    ws.send("ping");
                  } catch {
                    // Ignore.
                  }
                }
                sendEncrypted(REMOTE_DESKTOP_FRAME_TYPE.heartbeat, {
                  type: "ping",
                  t: Date.now(),
                });
              }
            }, 2500);
            statsTimer = setInterval(() => {
              callbacks.onStats({
                fps: framesInWindow,
                rttMs: latestRttMs,
                transport: activeTransport,
                encrypted: true,
                width: frameWidth,
                height: frameHeight,
              });
              framesInWindow = 0;
            }, 1000);
          })
          .catch((err) => {
            callbacks.onStatus(
              "error",
              err instanceof Error ? err.message : "E2EE handshake verification failed.",
            );
            ws.close(4003, "E2EE handshake failed");
          });
        return;
      }

      void session
        .decryptFrame(raw)
        .then((decoded) => {
          if (stopped || socket !== ws) return;
          if (decoded.frameType === REMOTE_DESKTOP_FRAME_TYPE.videoJpeg) {
            if (decoded.payload.byteLength <= 12) return;
            const jpegBytes = decoded.payload.subarray(12);
            void renderJpegFrame(jpegBytes);
            return;
          }
          if (decoded.frameType === REMOTE_DESKTOP_FRAME_TYPE.heartbeat) {
            const parsed = JSON.parse(textDecoder.decode(decoded.payload)) as {
              readonly type?: string;
              readonly t?: number;
            };
            if (parsed.type === "pong" && typeof parsed.t === "number") {
              latestRttMs = Math.max(0, Date.now() - parsed.t);
            }
            return;
          }
          if (decoded.frameType === REMOTE_DESKTOP_FRAME_TYPE.controlJson) {
            const parsed = JSON.parse(textDecoder.decode(decoded.payload)) as {
              readonly type?: string;
              readonly displays?: ReadonlyArray<RemoteDesktopDisplay>;
              readonly activeDisplayId?: string;
              readonly displayWidth?: number;
              readonly displayHeight?: number;
              readonly allowControl?: boolean;
              readonly quality?: RemoteDesktopQualityPreset;
              readonly maxFps?: number;
              readonly codec?: "h264" | "jpeg";
              readonly fingerprint?: string;
              readonly message?: string;
            };
            if (parsed.type === "session_info") {
              callbacks.onSessionInfo({
                displays: parsed.displays ?? [],
                activeDisplayId: parsed.activeDisplayId ?? "display-0",
                displayWidth: parsed.displayWidth ?? frameWidth,
                displayHeight: parsed.displayHeight ?? frameHeight,
                allowControl: Boolean(parsed.allowControl),
                quality: parsed.quality ?? "hd",
                maxFps: parsed.maxFps ?? 30,
                codec: parsed.codec ?? "jpeg",
                fingerprint: parsed.fingerprint ?? identity.fingerprint,
              });
            } else if (parsed.type === "capture_error" && parsed.message) {
              callbacks.onCaptureError?.(parsed.message);
            }
          }
        })
        .catch(() => {
          // Reject tampered or replayed frame silently.
        });
    });

    ws.addEventListener("close", (event) => {
      scheduleReconnect(event.reason || "Connection closed. Reconnecting...");
    });

    ws.addEventListener("error", () => {
      scheduleReconnect("Connection error. Reconnecting...");
    });
  };

  connect();

  return {
    sendInput: (event) => sendEncrypted(REMOTE_DESKTOP_FRAME_TYPE.inputJson, event),
    setDisplay: (displayId) =>
      sendEncrypted(REMOTE_DESKTOP_FRAME_TYPE.controlJson, {
        type: "set_display",
        displayId,
      }),
    setQuality: (quality, maxFps) =>
      sendEncrypted(REMOTE_DESKTOP_FRAME_TYPE.controlJson, {
        type: "set_quality",
        quality,
        ...(maxFps !== undefined ? { maxFps } : {}),
      }),
    reconnect: (transport) => {
      if (transport) {
        preference = transport;
      }
      directFailedOnce = false;
      backoffMs = 1000;
      connect();
    },
    stop: () => {
      stopped = true;
      clearTimers();
      session = null;
      if (socket) {
        try {
          socket.close(1000, "Viewer stopped");
        } catch {
          // Ignore.
        }
        socket = null;
      }
      callbacks.onStatus("disconnected");
    },
  };
}

// @effect-diagnostics globalTimers:off globalFetch:off -- Outbound relay WebSocket keepalive/reconnect and relay health probes run outside Effect clock loops.

import {
  RemoteDesktopConnectTicket,
  RemoteDesktopError,
  RemoteDesktopInputEvent,
  RemoteDesktopProbeRelayInput,
  RemoteDesktopProbeRelayResult,
  RemoteDesktopQualityPreset,
  RemoteDesktopRelayState,
  RemoteDesktopSettings,
  RemoteDesktopStatus,
  RemoteDesktopViewerSession,
  type RemoteDesktopDisplay,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  REMOTE_DESKTOP_FRAME_TYPE,
  RemoteDesktopCryptoSession,
  bytesToBase64Url,
  createHandshakeState,
  decodeRelayRoutedFrame,
  deriveRemoteDesktopRelayIdentity,
  encodeHandshakeFrame,
  encodeRelayRoutedFrame,
  encodeRemoteDesktopPairingUri,
  isHandshakeFrame,
  normalizeRelayHttpUrl,
  toRelayWebSocketUrl,
} from "@t3tools/shared/remoteDesktopCrypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { InputInjectionDriver, detectInputBackend } from "./InputInjectionDriver.ts";
import {
  type CaptureSessionHandle,
  detectCaptureBackend,
  listHostDisplays,
  startScreenCapture,
} from "./ScreenCaptureDriver.ts";

const MASTER_KEY_SECRET_NAME = "remote-desktop-master-key";
const DIRECT_TICKET_TTL_MS = 120_000;
const RELAY_PING_INTERVAL_MS = 25_000;
const textDecoder = new TextDecoder();
const decodeInputEvent = Schema.decodeUnknownOption(RemoteDesktopInputEvent);

export interface DirectSocketBridge {
  readonly sendBinary: (bytes: Uint8Array) => void;
  readonly close: (code?: number, reason?: string) => void;
}

interface ActiveViewer {
  readonly peerId: string;
  readonly label: string;
  readonly transport: "direct" | "relay";
  readonly controlAllowed: boolean;
  readonly connectedAt: string;
  readonly sendRaw: (bytes: Uint8Array) => void;
  readonly disconnect: (reason?: string) => void;
  cryptoSession: RemoteDesktopCryptoSession | null;
  sendingFrame: boolean;
}

interface DirectTicketRecord {
  readonly allowControl: boolean;
  readonly label: string;
  readonly expiresAt: number;
}

export class RemoteDesktopService extends Context.Service<
  RemoteDesktopService,
  {
    readonly getStatus: () => Effect.Effect<RemoteDesktopStatus, RemoteDesktopError>;
    readonly statusStream: Stream.Stream<RemoteDesktopStatus>;
    readonly issueTicket: (options?: {
      readonly allowControl?: boolean;
      readonly label?: string;
    }) => Effect.Effect<RemoteDesktopConnectTicket, RemoteDesktopError>;
    readonly rotateKey: () => Effect.Effect<RemoteDesktopStatus, RemoteDesktopError>;
    readonly disconnectViewer: (
      peerId: string,
    ) => Effect.Effect<RemoteDesktopStatus, RemoteDesktopError>;
    readonly probeRelay: (
      input: RemoteDesktopProbeRelayInput,
    ) => Effect.Effect<RemoteDesktopProbeRelayResult, RemoteDesktopError>;
    readonly consumeDirectTicket: (
      ticket: string,
    ) => Effect.Effect<Option.Option<{ readonly allowControl: boolean; readonly label: string }>>;
    readonly attachDirectViewer: (params: {
      readonly peerId: string;
      readonly label: string;
      readonly allowControl: boolean;
      readonly socket: DirectSocketBridge;
    }) => {
      readonly onBinaryMessage: (bytes: Uint8Array) => void;
      readonly onClose: () => void;
    };
  }
>()("t3/remoteDesktop/RemoteDesktopService") {}

function resolvePlatform(platform: NodeJS.Platform): RemoteDesktopStatus["platform"] {
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return platform;
  }
  return "other";
}

function toSafeRelayUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return normalizeRelayHttpUrl(trimmed);
  } catch {
    return null;
  }
}

function readSecretString(value: RemoteDesktopSettings["relayAccessToken"]): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  const statusPubSub = yield* PubSub.sliding<RemoteDesktopStatus>(16);
  const captureBackend = detectCaptureBackend(platform);
  const inputBackend = detectInputBackend(platform);
  const inputDriver = new InputInjectionDriver(config.stateDir, platform);

  let masterKey = bytesToBase64Url(
    yield* secretStore.getOrCreateRandom(MASTER_KEY_SECRET_NAME, 32).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteDesktopError({
            message: "Failed to initialize remote desktop encryption key.",
            cause,
          }),
      ),
    ),
  );
  let relayIdentity = deriveRemoteDesktopRelayIdentity(masterKey);
  let currentSettings: RemoteDesktopSettings = (yield* settingsService.getSettings).remoteDesktop;
  let displays: ReadonlyArray<RemoteDesktopDisplay> = yield* Effect.promise(() =>
    listHostDisplays(platform),
  );
  let activeDisplayId: string | null = displays[0]?.id ?? null;
  let currentQuality: RemoteDesktopQualityPreset = currentSettings.defaultQuality;
  let currentMaxFps = currentSettings.maxFps;

  let relayState: RemoteDesktopRelayState = "disabled";
  let relayError: string | null = null;
  let relaySocket: WebSocket | null = null;
  let relayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let relayPingTimer: ReturnType<typeof setInterval> | null = null;
  let relayBackoffMs = 1500;
  let relayGeneration = 0;

  let captureHandle: CaptureSessionHandle | null = null;
  let captureStartInFlight = false;
  let frameCounter = 0;
  let disposed = false;

  const viewers = new Map<string, ActiveViewer>();
  const directTickets = new Map<string, DirectTicketRecord>();

  const buildStatus = (): RemoteDesktopStatus => {
    const relayUrl = toSafeRelayUrl(currentSettings.relayUrl);
    return {
      enabled: currentSettings.enabled,
      allowControl: currentSettings.allowControl,
      platform: resolvePlatform(platform),
      captureBackend,
      inputBackend,
      relayUrl,
      relayState: currentSettings.enabled && relayUrl ? relayState : "disabled",
      relayError: currentSettings.enabled && relayUrl ? relayError : null,
      roomId: currentSettings.enabled ? relayIdentity.roomId : null,
      fingerprint: currentSettings.enabled ? relayIdentity.fingerprint : null,
      displays: [...displays],
      activeDisplayId,
      activeViewers: Array.from(viewers.values()).map((viewer): RemoteDesktopViewerSession => ({
        peerId: viewer.peerId,
        label: viewer.label,
        transport: viewer.transport,
        controlAllowed: viewer.controlAllowed && currentSettings.allowControl,
        connectedAt: viewer.connectedAt,
      })),
    };
  };

  const emitStatus = () => {
    if (disposed) return;
    Effect.runFork(PubSub.publish(statusPubSub, buildStatus()));
  };

  const activeDisplay = (): RemoteDesktopDisplay =>
    displays.find((d) => d.id === activeDisplayId) ??
    displays[0] ?? {
      id: "display-0",
      index: 0,
      name: "Primary Display",
      width: 1920,
      height: 1080,
      scaleFactor: 1,
      isPrimary: true,
    };

  const stopCaptureIfIdle = () => {
    const authenticatedCount = Array.from(viewers.values()).filter(
      (v) => v.cryptoSession !== null,
    ).length;
    if (authenticatedCount === 0 && captureHandle) {
      captureHandle.stop();
      captureHandle = null;
    }
  };

  const sendEncryptedJsonToViewer = (
    viewer: ActiveViewer,
    frameType:
      | typeof REMOTE_DESKTOP_FRAME_TYPE.controlJson
      | typeof REMOTE_DESKTOP_FRAME_TYPE.heartbeat,
    payload: unknown,
  ) => {
    const session = viewer.cryptoSession;
    if (!session) return;
    void session
      .encryptJson(frameType, payload)
      .then((encrypted) => {
        if (viewers.get(viewer.peerId) === viewer) {
          viewer.sendRaw(encrypted);
        }
      })
      .catch(() => {
        // Viewer disconnected mid-encrypt.
      });
  };

  const broadcastControlState = () => {
    const display = activeDisplay();
    for (const viewer of viewers.values()) {
      if (!viewer.cryptoSession) continue;
      sendEncryptedJsonToViewer(viewer, REMOTE_DESKTOP_FRAME_TYPE.controlJson, {
        type: "session_info",
        displays,
        activeDisplayId: display.id,
        displayWidth: display.width,
        displayHeight: display.height,
        allowControl: viewer.controlAllowed && currentSettings.allowControl,
        quality: currentQuality,
        maxFps: currentMaxFps,
        codec: "jpeg",
        fingerprint: relayIdentity.fingerprint,
      });
    }
  };

  const broadcastFrame = (jpegBytes: Uint8Array) => {
    frameCounter += 1;
    const seqNum = frameCounter;
    const now = Date.now();
    // Prefix 12-byte metadata header inside the encrypted payload: [4B frameSeq][8B timestampMs]
    const payload = new Uint8Array(12 + jpegBytes.byteLength);
    const view = new DataView(payload.buffer);
    view.setUint32(0, seqNum >>> 0, false);
    view.setBigUint64(4, BigInt(now), false);
    payload.set(jpegBytes, 12);

    for (const viewer of viewers.values()) {
      const session = viewer.cryptoSession;
      if (!session || viewer.sendingFrame) continue;
      viewer.sendingFrame = true;
      void session
        .encryptFrame(REMOTE_DESKTOP_FRAME_TYPE.videoJpeg, payload)
        .then((encrypted) => {
          if (viewers.get(viewer.peerId) === viewer) {
            viewer.sendRaw(encrypted);
          }
        })
        .catch(() => {
          // Drop frame if encryption/send fails while disconnecting.
        })
        .finally(() => {
          viewer.sendingFrame = false;
        });
    }
  };

  const restartCapture = async () => {
    if (disposed) return;
    if (captureHandle) {
      captureHandle.stop();
      captureHandle = null;
    }
    const authenticatedCount = Array.from(viewers.values()).filter(
      (v) => v.cryptoSession !== null,
    ).length;
    if (authenticatedCount === 0 || !currentSettings.enabled) return;
    if (captureStartInFlight) return;
    captureStartInFlight = true;
    try {
      const handle = await startScreenCapture(
        platform,
        {
          display: activeDisplay(),
          quality: currentQuality,
          maxFps: currentMaxFps,
        },
        {
          onFrame: (jpegBytes) => broadcastFrame(jpegBytes),
          onError: (message) => {
            for (const viewer of viewers.values()) {
              sendEncryptedJsonToViewer(viewer, REMOTE_DESKTOP_FRAME_TYPE.controlJson, {
                type: "capture_error",
                message,
              });
            }
          },
        },
      );
      if (disposed || viewers.size === 0 || !currentSettings.enabled) {
        handle.stop();
      } else {
        captureHandle = handle;
      }
    } finally {
      captureStartInFlight = false;
    }
  };

  const ensureCaptureRunning = () => {
    if (!captureHandle && !captureStartInFlight && currentSettings.enabled) {
      void restartCapture();
    }
  };

  const removeViewer = (peerId: string) => {
    const existing = viewers.get(peerId);
    if (!existing) return;
    viewers.delete(peerId);
    stopCaptureIfIdle();
    emitStatus();
  };

  const handleViewerBinaryFrame = async (viewer: ActiveViewer, frame: Uint8Array) => {
    if (!currentSettings.enabled) {
      viewer.disconnect("Remote desktop disabled");
      removeViewer(viewer.peerId);
      return;
    }

    if (!viewer.cryptoSession) {
      if (!isHandshakeFrame(frame)) {
        viewer.disconnect("Expected E2EE handshake");
        removeViewer(viewer.peerId);
        return;
      }
      try {
        const hostHs = createHandshakeState("host", relayIdentity.roomId);
        const ackFrame = encodeHandshakeFrame(hostHs, masterKey);
        const session = await RemoteDesktopCryptoSession.establish({
          localState: hostHs,
          peerHandshakeFrame: frame,
          masterKey,
        });
        if (viewers.get(viewer.peerId) !== viewer) return;
        viewer.cryptoSession = session;
        viewer.sendRaw(ackFrame);
        displays = await listHostDisplays(platform);
        if (!activeDisplayId || !displays.some((d) => d.id === activeDisplayId)) {
          activeDisplayId = displays[0]?.id ?? null;
        }
        broadcastControlState();
        ensureCaptureRunning();
        emitStatus();
      } catch {
        viewer.disconnect("E2EE handshake failed");
        removeViewer(viewer.peerId);
      }
      return;
    }

    try {
      const decoded = await viewer.cryptoSession.decryptFrame(frame);
      if (decoded.frameType === REMOTE_DESKTOP_FRAME_TYPE.heartbeat) {
        const parsed = JSON.parse(textDecoder.decode(decoded.payload)) as {
          readonly t?: number;
        };
        sendEncryptedJsonToViewer(viewer, REMOTE_DESKTOP_FRAME_TYPE.heartbeat, {
          type: "pong",
          t: parsed.t ?? Date.now(),
        });
        return;
      }
      if (
        decoded.frameType === REMOTE_DESKTOP_FRAME_TYPE.inputJson ||
        decoded.frameType === REMOTE_DESKTOP_FRAME_TYPE.controlJson
      ) {
        const json = JSON.parse(textDecoder.decode(decoded.payload)) as unknown;
        const parsed = decodeInputEvent(json);
        if (Option.isNone(parsed)) return;
        const event = parsed.value;
        if (event.type === "set_display") {
          if (displays.some((d) => d.id === event.displayId)) {
            activeDisplayId = event.displayId;
            broadcastControlState();
            void restartCapture();
            emitStatus();
          }
          return;
        }
        if (event.type === "set_quality") {
          currentQuality = event.quality;
          if (event.maxFps !== undefined) {
            currentMaxFps = Math.max(5, Math.min(60, event.maxFps));
          }
          broadcastControlState();
          void restartCapture();
          return;
        }
        if (event.type === "request_keyframe") {
          return;
        }
        if (currentSettings.allowControl && viewer.controlAllowed) {
          await inputDriver.dispatch(event, activeDisplay());
        }
      }
    } catch {
      // Ignore malformed/replayed frames; drop viewer on persistent auth error.
    }
  };

  const clearRelayTimers = () => {
    if (relayReconnectTimer) {
      clearTimeout(relayReconnectTimer);
      relayReconnectTimer = null;
    }
    if (relayPingTimer) {
      clearInterval(relayPingTimer);
      relayPingTimer = null;
    }
  };

  const disconnectRelaySocket = (targetState: RemoteDesktopRelayState = "disabled") => {
    relayGeneration += 1;
    clearRelayTimers();
    if (relaySocket) {
      try {
        relaySocket.close(1000, "Host closing relay connection");
      } catch {
        // Ignore.
      }
      relaySocket = null;
    }
    for (const [peerId, viewer] of viewers) {
      if (viewer.transport === "relay") {
        viewers.delete(peerId);
      }
    }
    stopCaptureIfIdle();
    relayState = targetState;
    if (targetState === "disabled") {
      relayError = null;
    }
    emitStatus();
  };

  const connectRelay = () => {
    if (disposed) return;
    const relayUrl = toSafeRelayUrl(currentSettings.relayUrl);
    if (!currentSettings.enabled || !relayUrl) {
      disconnectRelaySocket("disabled");
      return;
    }

    const gen = ++relayGeneration;
    clearRelayTimers();
    if (relaySocket) {
      try {
        relaySocket.close(1000, "Reconnecting relay");
      } catch {
        // Ignore.
      }
      relaySocket = null;
    }

    relayState = relayState === "reconnecting" ? "reconnecting" : "connecting";
    relayError = null;
    emitStatus();

    const accessToken = readSecretString(currentSettings.relayAccessToken) ?? undefined;
    const wsUrl = toRelayWebSocketUrl(relayUrl, relayIdentity.roomId, {
      role: "host",
      authHash: relayIdentity.roomAuthHash,
      ...(accessToken ? { accessToken } : {}),
    });

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    relaySocket = ws;

    const scheduleReconnect = (reason: string) => {
      if (disposed || gen !== relayGeneration) return;
      clearRelayTimers();
      if (relaySocket === ws) relaySocket = null;
      for (const [peerId, viewer] of viewers) {
        if (viewer.transport === "relay") {
          viewers.delete(peerId);
        }
      }
      stopCaptureIfIdle();
      relayState = "reconnecting";
      relayError = reason;
      emitStatus();

      const delay = relayBackoffMs;
      relayBackoffMs = Math.min(15_000, Math.round(relayBackoffMs * 1.8));
      relayReconnectTimer = setTimeout(() => {
        if (!disposed && gen === relayGeneration) {
          connectRelay();
        }
      }, delay);
    };

    ws.addEventListener("open", () => {
      if (disposed || gen !== relayGeneration) return;
      relayBackoffMs = 1500;
      relayState = "connected";
      relayError = null;
      emitStatus();
      relayPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send("ping");
          } catch {
            // Ignore.
          }
        }
      }, RELAY_PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (event) => {
      if (disposed || gen !== relayGeneration) return;
      if (typeof event.data === "string") {
        if (event.data === "pong") return;
        try {
          const msg = JSON.parse(event.data) as {
            readonly type?: string;
            readonly peerId?: string;
            readonly message?: string;
          };
          if (msg.type === "peer_left" && typeof msg.peerId === "string") {
            removeViewer(msg.peerId);
          } else if (msg.type === "error" && typeof msg.message === "string") {
            relayError = msg.message;
            emitStatus();
          }
        } catch {
          // Ignore malformed relay control text.
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

      const routed = decodeRelayRoutedFrame(raw);
      if (!routed) return;

      let viewer = viewers.get(routed.peerId);
      if (!viewer) {
        viewer = {
          peerId: routed.peerId,
          label: `Relay Viewer (${routed.peerId.slice(0, 8)})`,
          transport: "relay",
          controlAllowed: true,
          connectedAt: new Date().toISOString(),
          sendRaw: (encryptedBytes) => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(encodeRelayRoutedFrame(routed.peerId, encryptedBytes));
              } catch {
                // Ignore send errors on closing relay socket.
              }
            }
          },
          disconnect: () => {
            removeViewer(routed.peerId);
          },
          cryptoSession: null,
          sendingFrame: false,
        };
        viewers.set(routed.peerId, viewer);
      }

      void handleViewerBinaryFrame(viewer, routed.payload);
    });

    ws.addEventListener("close", (event) => {
      scheduleReconnect(event.reason || `Relay connection closed (${String(event.code || 1006)})`);
    });

    ws.addEventListener("error", () => {
      scheduleReconnect("Unable to reach Cloudflare relay server.");
    });
  };

  const applySettings = (next: RemoteDesktopSettings) => {
    const prev = currentSettings;
    currentSettings = next;
    currentQuality = next.defaultQuality;
    currentMaxFps = next.maxFps;

    const prevRelay = toSafeRelayUrl(prev.relayUrl);
    const nextRelay = toSafeRelayUrl(next.relayUrl);
    const prevToken = readSecretString(prev.relayAccessToken);
    const nextToken = readSecretString(next.relayAccessToken);

    if (!next.enabled) {
      for (const viewer of Array.from(viewers.values())) {
        viewer.disconnect("Remote desktop disabled");
        viewers.delete(viewer.peerId);
      }
      stopCaptureIfIdle();
      disconnectRelaySocket("disabled");
      return;
    }

    if (!prev.enabled || prevRelay !== nextRelay || prevToken !== nextToken) {
      if (nextRelay) {
        connectRelay();
      } else {
        disconnectRelaySocket("disabled");
      }
    }

    if (prev.allowControl !== next.allowControl) {
      broadcastControlState();
      emitStatus();
    }
    if (prev.defaultQuality !== next.defaultQuality || prev.maxFps !== next.maxFps) {
      void restartCapture();
    }
  };

  // Start relay immediately if enabled in persisted settings.
  if (currentSettings.enabled && toSafeRelayUrl(currentSettings.relayUrl)) {
    connectRelay();
  }

  // React to ServerSettings updates continuously.
  const settingsWatchFiber = yield* settingsService.streamChanges.pipe(
    Stream.runForEach((settings) =>
      Effect.sync(() => {
        applySettings(settings.remoteDesktop);
      }),
    ),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      disposed = true;
      yield* Fiber.interrupt(settingsWatchFiber);
      disconnectRelaySocket("disabled");
      for (const viewer of Array.from(viewers.values())) {
        viewer.disconnect("Server shutting down");
      }
      viewers.clear();
      if (captureHandle) {
        captureHandle.stop();
        captureHandle = null;
      }
      inputDriver.dispose();
    }),
  );

  const getStatus = Effect.fn("RemoteDesktopService.getStatus")(function* () {
    displays = yield* Effect.promise(() => listHostDisplays(platform));
    if (!activeDisplayId || !displays.some((d) => d.id === activeDisplayId)) {
      activeDisplayId = displays[0]?.id ?? null;
    }
    return buildStatus();
  });

  const issueTicket = Effect.fn("RemoteDesktopService.issueTicket")(function* (options?: {
    readonly allowControl?: boolean;
    readonly label?: string;
  }) {
    if (!currentSettings.enabled) {
      return yield* new RemoteDesktopError({
        message: "Remote desktop is disabled on this machine. Enable it in Settings first.",
      });
    }
    displays = yield* Effect.promise(() => listHostDisplays(platform));
    if (!activeDisplayId || !displays.some((d) => d.id === activeDisplayId)) {
      activeDisplayId = displays[0]?.id ?? null;
    }

    const descriptor = yield* serverEnvironment.getDescriptor;
    const ticketBytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(ticketBytes);
    const directTicket = bytesToBase64Url(ticketBytes);
    const now = Date.now();

    // Prune expired direct tickets.
    for (const [key, entry] of directTickets) {
      if (entry.expiresAt <= now) directTickets.delete(key);
    }
    const allowControl = (options?.allowControl ?? true) && currentSettings.allowControl;
    directTickets.set(directTicket, {
      allowControl,
      label: options?.label?.trim() || "Direct Viewer",
      expiresAt: now + DIRECT_TICKET_TTL_MS,
    });

    const relayUrl = toSafeRelayUrl(currentSettings.relayUrl);
    const relayAccessToken = readSecretString(currentSettings.relayAccessToken);
    const pairingUri = relayUrl
      ? encodeRemoteDesktopPairingUri({
          relayUrl,
          masterKey,
          label: descriptor.label,
          ...(relayAccessToken ? { relayAccessToken } : {}),
        })
      : null;

    return {
      environmentId: descriptor.environmentId,
      environmentLabel: descriptor.label,
      directWsPath: "/api/remote-desktop/ws",
      directTicket,
      relayUrl,
      relayAccessToken,
      roomId: relayIdentity.roomId,
      roomAuthHash: relayIdentity.roomAuthHash,
      masterKey,
      fingerprint: relayIdentity.fingerprint,
      pairingUri,
      allowControl,
      displays: [...displays],
      activeDisplayId,
      preferredCodec: "jpeg" as const,
    } satisfies RemoteDesktopConnectTicket;
  });

  const rotateKey = Effect.fn("RemoteDesktopService.rotateKey")(function* () {
    const freshBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(freshBytes);
    yield* secretStore.set(MASTER_KEY_SECRET_NAME, freshBytes).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteDesktopError({
            message: "Failed to rotate remote desktop encryption key.",
            cause,
          }),
      ),
    );
    masterKey = bytesToBase64Url(freshBytes);
    relayIdentity = deriveRemoteDesktopRelayIdentity(masterKey);
    directTickets.clear();
    for (const viewer of Array.from(viewers.values())) {
      viewer.disconnect("Encryption key rotated");
      viewers.delete(viewer.peerId);
    }
    stopCaptureIfIdle();
    if (currentSettings.enabled && toSafeRelayUrl(currentSettings.relayUrl)) {
      connectRelay();
    } else {
      emitStatus();
    }
    return buildStatus();
  });

  const disconnectViewer = Effect.fn("RemoteDesktopService.disconnectViewer")(function* (
    peerId: string,
  ) {
    return yield* Effect.sync(() => {
      const viewer = viewers.get(peerId);
      if (viewer) {
        viewer.disconnect("Disconnected by host");
        removeViewer(peerId);
      }
      return buildStatus();
    });
  });

  const probeRelay = Effect.fn("RemoteDesktopService.probeRelay")(function* (
    input: RemoteDesktopProbeRelayInput,
  ) {
    const normalized = toSafeRelayUrl(input.relayUrl);
    if (!normalized) {
      return {
        ok: false,
        relayUrl: input.relayUrl,
        protocolVersion: null,
        authRequired: false,
        latencyMs: null,
        error: "Invalid relay URL.",
      } satisfies RemoteDesktopProbeRelayResult;
    }

    return yield* Effect.promise(async (): Promise<RemoteDesktopProbeRelayResult> => {
      const started = Date.now();
      try {
        const headers: Record<string, string> = {};
        if (input.relayAccessToken?.trim()) {
          headers["X-Relay-Token"] = input.relayAccessToken.trim();
        }
        const response = await fetch(`${normalized}/health`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(6000),
        });
        const latencyMs = Date.now() - started;
        if (!response.ok) {
          return {
            ok: false,
            relayUrl: normalized,
            protocolVersion: null,
            authRequired: false,
            latencyMs,
            error: `Relay health check returned HTTP ${response.status}.`,
          };
        }
        const body = (await response.json()) as {
          readonly ok?: boolean;
          readonly service?: string;
          readonly protocolVersion?: number;
          readonly authRequired?: boolean;
        };
        if (!body.ok || body.service !== "tix-relay") {
          return {
            ok: false,
            relayUrl: normalized,
            protocolVersion: null,
            authRequired: false,
            latencyMs,
            error: "Endpoint is reachable but does not look like a TiX Relay Worker.",
          };
        }
        return {
          ok: true,
          relayUrl: normalized,
          protocolVersion: typeof body.protocolVersion === "number" ? body.protocolVersion : null,
          authRequired: Boolean(body.authRequired),
          latencyMs,
          error: null,
        };
      } catch (err) {
        return {
          ok: false,
          relayUrl: normalized,
          protocolVersion: null,
          authRequired: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : "Failed to reach relay server.",
        };
      }
    });
  });

  const consumeDirectTicket = Effect.fn("RemoteDesktopService.consumeDirectTicket")(function* (
    ticket: string,
  ) {
    return yield* Effect.sync(() => {
      const record = directTickets.get(ticket);
      if (!record) return Option.none();
      directTickets.delete(ticket);
      if (record.expiresAt <= Date.now()) return Option.none();
      return Option.some({
        allowControl: record.allowControl,
        label: record.label,
      });
    });
  });

  const attachDirectViewer: RemoteDesktopService["Service"]["attachDirectViewer"] = (params) => {
    const viewer: ActiveViewer = {
      peerId: params.peerId,
      label: params.label,
      transport: "direct",
      controlAllowed: params.allowControl,
      connectedAt: new Date().toISOString(),
      sendRaw: (encryptedBytes) => params.socket.sendBinary(encryptedBytes),
      disconnect: (reason) => params.socket.close(1000, reason ?? "Disconnected"),
      cryptoSession: null,
      sendingFrame: false,
    };
    const previous = viewers.get(params.peerId);
    if (previous) {
      previous.disconnect("Replaced by new direct session");
    }
    viewers.set(params.peerId, viewer);
    emitStatus();

    return {
      onBinaryMessage: (bytes) => {
        void handleViewerBinaryFrame(viewer, bytes);
      },
      onClose: () => {
        if (viewers.get(params.peerId) === viewer) {
          removeViewer(params.peerId);
        }
      },
    };
  };

  const statusStream: Stream.Stream<RemoteDesktopStatus> = Stream.concat(
    Stream.fromEffect(Effect.sync(() => buildStatus())),
    Stream.fromPubSub(statusPubSub),
  );

  return RemoteDesktopService.of({
    getStatus,
    statusStream,
    issueTicket,
    rotateKey,
    disconnectViewer,
    probeRelay,
    consumeDirectTicket,
    attachDirectViewer,
  });
});

export const layer = Layer.effect(RemoteDesktopService, make);

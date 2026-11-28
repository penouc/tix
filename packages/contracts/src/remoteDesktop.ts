import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

export const RemoteDesktopQualityPreset = Schema.Literals(["auto", "smooth", "hd", "ultra"]);
export type RemoteDesktopQualityPreset = typeof RemoteDesktopQualityPreset.Type;

export const RemoteDesktopCodec = Schema.Literals(["h264", "jpeg"]);
export type RemoteDesktopCodec = typeof RemoteDesktopCodec.Type;

export const RemoteDesktopRelayState = Schema.Literals([
  "disabled",
  "connecting",
  "connected",
  "reconnecting",
  "error",
]);
export type RemoteDesktopRelayState = typeof RemoteDesktopRelayState.Type;

export const RemoteDesktopTransportKind = Schema.Literals(["direct", "relay"]);
export type RemoteDesktopTransportKind = typeof RemoteDesktopTransportKind.Type;

export const RemoteDesktopMouseButton = Schema.Literals(["left", "right", "middle"]);
export type RemoteDesktopMouseButton = typeof RemoteDesktopMouseButton.Type;

export const RemoteDesktopDisplay = Schema.Struct({
  id: TrimmedNonEmptyString,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: TrimmedNonEmptyString,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  scaleFactor: Schema.Finite.check(Schema.isGreaterThan(0)),
  isPrimary: Schema.Boolean,
});
export type RemoteDesktopDisplay = typeof RemoteDesktopDisplay.Type;

export const RemoteDesktopViewerSession = Schema.Struct({
  peerId: TrimmedNonEmptyString,
  label: TrimmedString,
  transport: RemoteDesktopTransportKind,
  controlAllowed: Schema.Boolean,
  connectedAt: IsoDateTime,
});
export type RemoteDesktopViewerSession = typeof RemoteDesktopViewerSession.Type;

export const RemoteDesktopSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  allowControl: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Custom Cloudflare Worker relay URL, e.g. https://relay.penglei.dev */
  relayUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Optional operator access token matching RELAY_ACCESS_TOKEN on the Cloudflare Worker. */
  relayAccessToken: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  defaultQuality: RemoteDesktopQualityPreset.pipe(
    Schema.withDecodingDefault(Effect.succeed("hd" as const)),
  ),
  maxFps: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 60 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(30)),
  ),
});
export type RemoteDesktopSettings = typeof RemoteDesktopSettings.Type;

export const RemoteDesktopSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  allowControl: Schema.optionalKey(Schema.Boolean),
  relayUrl: Schema.optionalKey(TrimmedString),
  relayAccessToken: Schema.optionalKey(SettingsSecretValue),
  defaultQuality: Schema.optionalKey(RemoteDesktopQualityPreset),
  maxFps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 60 }))),
});
export type RemoteDesktopSettingsPatch = typeof RemoteDesktopSettingsPatch.Type;

export const RemoteDesktopStatus = Schema.Struct({
  enabled: Schema.Boolean,
  allowControl: Schema.Boolean,
  platform: Schema.Literals(["darwin", "win32", "linux", "other"]),
  captureBackend: Schema.Literals(["ffmpeg-h264", "screencapture-jpeg", "unavailable"]),
  inputBackend: Schema.Literals([
    "macos-cgevent",
    "win32-sendinput",
    "linux-xdotool",
    "unavailable",
  ]),
  relayUrl: Schema.NullOr(TrimmedNonEmptyString),
  relayState: RemoteDesktopRelayState,
  relayError: Schema.NullOr(TrimmedString),
  roomId: Schema.NullOr(TrimmedNonEmptyString),
  fingerprint: Schema.NullOr(TrimmedNonEmptyString),
  displays: Schema.Array(RemoteDesktopDisplay),
  activeDisplayId: Schema.NullOr(TrimmedNonEmptyString),
  activeViewers: Schema.Array(RemoteDesktopViewerSession),
});
export type RemoteDesktopStatus = typeof RemoteDesktopStatus.Type;

export const RemoteDesktopConnectTicket = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: TrimmedNonEmptyString,
  /** Relative path on this TiX server for direct LAN/Tailscale streaming. */
  directWsPath: TrimmedNonEmptyString,
  directTicket: TrimmedNonEmptyString,
  relayUrl: Schema.NullOr(TrimmedNonEmptyString),
  relayAccessToken: Schema.NullOr(TrimmedNonEmptyString),
  roomId: TrimmedNonEmptyString,
  roomAuthHash: TrimmedNonEmptyString,
  /** 256-bit E2EE master key; delivered only to authorized TiX sessions, never to the relay. */
  masterKey: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  pairingUri: Schema.NullOr(TrimmedNonEmptyString),
  allowControl: Schema.Boolean,
  displays: Schema.Array(RemoteDesktopDisplay),
  activeDisplayId: Schema.NullOr(TrimmedNonEmptyString),
  preferredCodec: RemoteDesktopCodec,
});
export type RemoteDesktopConnectTicket = typeof RemoteDesktopConnectTicket.Type;

export const RemoteDesktopProbeRelayInput = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  relayAccessToken: Schema.optionalKey(TrimmedString),
});
export type RemoteDesktopProbeRelayInput = typeof RemoteDesktopProbeRelayInput.Type;

export const RemoteDesktopProbeRelayResult = Schema.Struct({
  ok: Schema.Boolean,
  relayUrl: TrimmedNonEmptyString,
  protocolVersion: Schema.NullOr(Schema.Int),
  authRequired: Schema.Boolean,
  latencyMs: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(TrimmedString),
});
export type RemoteDesktopProbeRelayResult = typeof RemoteDesktopProbeRelayResult.Type;

export const RemoteDesktopDisconnectViewerInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
});
export type RemoteDesktopDisconnectViewerInput = typeof RemoteDesktopDisconnectViewerInput.Type;

export const RemoteDesktopInputEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("mouse_move"),
    /** Normalized [0..1] X coordinate on active display. */
    x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    /** Normalized [0..1] Y coordinate on active display. */
    y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  Schema.Struct({
    type: Schema.Literal("mouse_button"),
    button: RemoteDesktopMouseButton,
    action: Schema.Literals(["down", "up", "click", "double_click"]),
    x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  Schema.Struct({
    type: Schema.Literal("mouse_scroll"),
    deltaX: Schema.Finite,
    deltaY: Schema.Finite,
    x: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
    y: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up", "press"]),
    key: TrimmedNonEmptyString,
    modifiers: Schema.optionalKey(Schema.Array(Schema.Literals(["ctrl", "alt", "shift", "meta"]))),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMaxLength(2048)),
  }),
  Schema.Struct({
    type: Schema.Literal("set_display"),
    displayId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("set_quality"),
    quality: RemoteDesktopQualityPreset,
    maxFps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 60 }))),
  }),
  Schema.Struct({
    type: Schema.Literal("request_keyframe"),
  }),
]);
export type RemoteDesktopInputEvent = typeof RemoteDesktopInputEvent.Type;

export class RemoteDesktopError extends Schema.TaggedError<RemoteDesktopError>()(
  "RemoteDesktopError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return super.message;
  }
}

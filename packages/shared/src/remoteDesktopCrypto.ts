import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const REMOTE_DESKTOP_CRYPTO_VERSION = 1;

export const REMOTE_DESKTOP_FRAME_TYPE = {
  handshakeInit: 0x01,
  handshakeAck: 0x02,
  controlJson: 0x10,
  videoH264: 0x11,
  videoJpeg: 0x12,
  inputJson: 0x13,
  heartbeat: 0x14,
} as const;

export type RemoteDesktopFrameType =
  (typeof REMOTE_DESKTOP_FRAME_TYPE)[keyof typeof REMOTE_DESKTOP_FRAME_TYPE];

export type RemoteDesktopPeerRole = "host" | "viewer";

const DIRECTION_HOST_TO_VIEWER = 0x01;
const DIRECTION_VIEWER_TO_HOST = 0x02;

const HEADER_BYTES = 14;
const HANDSHAKE_BODY_BYTES = 32 + 16 + 32; // ephemeralPub(32) + nonce(16) + hmac(32)
const HANDSHAKE_FRAME_BYTES = 2 + HANDSHAKE_BODY_BYTES;
const MAX_PEER_ID_LENGTH = 64;

const SALT_V1 = utf8ToBytes("tix-remote-desktop-v1");
const INFO_ROOM_ID = utf8ToBytes("tix-rd-room-id");
const INFO_ROOM_AUTH = utf8ToBytes("tix-rd-room-auth");
const INFO_PSK_AUTH = utf8ToBytes("tix-rd-psk-auth");
const INFO_FINGERPRINT = utf8ToBytes("tix-rd-fingerprint");
const INFO_KEY_H2V = utf8ToBytes("tix-rd-session-h2v");
const INFO_KEY_V2H = utf8ToBytes("tix-rd-session-v2h");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(encoded: string): Uint8Array {
  const trimmed = encoded.trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(trimmed)) {
    throw new Error("Invalid base64url master key");
  }
  const padded = trimmed
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(trimmed.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function generateRemoteDesktopMasterKey(): string {
  return bytesToBase64Url(getRandomBytes(32));
}

function decodeRemoteDesktopMasterKey(masterKey: string): Uint8Array {
  const bytes = base64UrlToBytes(masterKey);
  if (bytes.byteLength !== 32) {
    throw new Error(`Expected 32-byte master key, received ${bytes.byteLength} bytes`);
  }
  return bytes;
}

export interface RemoteDesktopRelayIdentity {
  /** Opaque 64-hex room identifier sent to the Cloudflare relay URL. */
  readonly roomId: string;
  /** Opaque 64-hex hash sent to the relay to prevent unauthorized room squatting. */
  readonly roomAuthHash: string;
  /** Human-readable verification fingerprint (e.g. A3F9-82C1-4D0E). */
  readonly fingerprint: string;
}

/**
 * Derives zero-knowledge relay routing identifiers from the 256-bit master key.
 * Neither `roomId` nor `roomAuthHash` can be reversed to recover `masterKey`.
 */
export function deriveRemoteDesktopRelayIdentity(masterKey: string): RemoteDesktopRelayIdentity {
  const keyBytes = decodeRemoteDesktopMasterKey(masterKey);
  const roomIdBytes = hkdf(sha256, keyBytes, SALT_V1, INFO_ROOM_ID, 32);
  const roomAuthSecret = hkdf(sha256, keyBytes, SALT_V1, INFO_ROOM_AUTH, 32);
  const roomAuthHashBytes = sha256(roomAuthSecret);
  const fpBytes = hkdf(sha256, keyBytes, SALT_V1, INFO_FINGERPRINT, 6);
  const fpHex = bytesToHex(fpBytes).toUpperCase();
  const fingerprint = `${fpHex.slice(0, 4)}-${fpHex.slice(4, 8)}-${fpHex.slice(8, 12)}`;
  return {
    roomId: bytesToHex(roomIdBytes),
    roomAuthHash: bytesToHex(roomAuthHashBytes),
    fingerprint,
  };
}

export interface RemoteDesktopPairingPayload {
  readonly relayUrl: string;
  readonly masterKey: string;
  readonly label?: string;
  readonly relayAccessToken?: string;
}

/**
 * Builds a shareable pairing URI whose master key lives in the URL fragment (`#k=...`)
 * so proxies, logs, and servers never receive the encryption secret in HTTP paths/queries.
 */
export function encodeRemoteDesktopPairingUri(payload: RemoteDesktopPairingPayload): string {
  const normalizedRelay = normalizeRelayHttpUrl(payload.relayUrl);
  const query = new URLSearchParams({ relay: normalizedRelay });
  if (payload.label?.trim()) {
    query.set("label", payload.label.trim());
  }
  const fragment = new URLSearchParams({ k: payload.masterKey.trim() });
  if (payload.relayAccessToken?.trim()) {
    fragment.set("t", payload.relayAccessToken.trim());
  }
  return `tixrd://v1?${query.toString()}#${fragment.toString()}`;
}

export function decodeRemoteDesktopPairingUri(uri: string): RemoteDesktopPairingPayload {
  const trimmed = uri.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "tixrd:") {
    throw new Error("Unsupported remote desktop pairing URI protocol");
  }
  const relay = parsed.searchParams.get("relay")?.trim() ?? "";
  if (!relay) {
    throw new Error("Pairing URI is missing relay URL");
  }
  const fragment = new URLSearchParams(parsed.hash.startsWith("#") ? parsed.hash.slice(1) : "");
  const masterKey = fragment.get("k")?.trim() ?? "";
  decodeRemoteDesktopMasterKey(masterKey);
  const label = parsed.searchParams.get("label")?.trim() || undefined;
  const relayAccessToken = fragment.get("t")?.trim() || undefined;
  return {
    relayUrl: normalizeRelayHttpUrl(relay),
    masterKey,
    ...(label ? { label } : {}),
    ...(relayAccessToken ? { relayAccessToken } : {}),
  };
}

export function normalizeRelayHttpUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("Relay URL cannot be empty");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported relay URL protocol: ${parsed.protocol}`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/u, "");
}

export function toRelayWebSocketUrl(
  relayHttpUrl: string,
  roomId: string,
  params: {
    readonly role: RemoteDesktopPeerRole;
    readonly authHash: string;
    readonly peerId?: string;
    readonly accessToken?: string;
  },
): string {
  const base = new URL(normalizeRelayHttpUrl(relayHttpUrl));
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/+$/u, "")}/r/${roomId}/ws`;
  base.searchParams.set("role", params.role);
  base.searchParams.set("auth", params.authHash);
  if (params.peerId) {
    base.searchParams.set("peerId", params.peerId);
  }
  if (params.accessToken?.trim()) {
    base.searchParams.set("token", params.accessToken.trim());
  }
  return base.toString();
}

export function encodeRelayRoutedFrame(peerId: string, payload: Uint8Array): Uint8Array {
  const idBytes = textEncoder.encode(peerId);
  if (idBytes.byteLength === 0 || idBytes.byteLength > MAX_PEER_ID_LENGTH) {
    throw new Error(`Invalid relay peerId length: ${idBytes.byteLength}`);
  }
  const out = new Uint8Array(1 + idBytes.byteLength + payload.byteLength);
  out[0] = idBytes.byteLength;
  out.set(idBytes, 1);
  out.set(payload, 1 + idBytes.byteLength);
  return out;
}

export function decodeRelayRoutedFrame(
  raw: Uint8Array,
): { readonly peerId: string; readonly payload: Uint8Array } | null {
  if (raw.byteLength < 2) return null;
  const idLen = raw[0]!;
  if (idLen === 0 || idLen > MAX_PEER_ID_LENGTH || raw.byteLength < 1 + idLen) {
    return null;
  }
  return {
    peerId: textDecoder.decode(raw.subarray(1, 1 + idLen)),
    payload: raw.subarray(1 + idLen),
  };
}

export interface EphemeralHandshakeState {
  readonly role: RemoteDesktopPeerRole;
  readonly roomId: string;
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly nonce: Uint8Array;
}

function handshakeTranscript(
  roomId: string,
  role: RemoteDesktopPeerRole,
  publicKey: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return concatBytes(
    utf8ToBytes("tix-rd-handshake-v1:"),
    utf8ToBytes(roomId),
    utf8ToBytes(":"),
    utf8ToBytes(role),
    utf8ToBytes(":"),
    publicKey,
    nonce,
  );
}

export function createHandshakeState(
  role: RemoteDesktopPeerRole,
  roomId: string,
): EphemeralHandshakeState {
  const privateKey = getRandomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  const nonce = getRandomBytes(16);
  return { role, roomId, privateKey, publicKey, nonce };
}

export function encodeHandshakeFrame(
  state: EphemeralHandshakeState,
  masterKey: string,
): Uint8Array {
  const keyBytes = decodeRemoteDesktopMasterKey(masterKey);
  const pskAuthKey = hkdf(sha256, keyBytes, SALT_V1, INFO_PSK_AUTH, 32);
  const mac = hmac(
    sha256,
    pskAuthKey,
    handshakeTranscript(state.roomId, state.role, state.publicKey, state.nonce),
  );
  const frameType =
    state.role === "viewer"
      ? REMOTE_DESKTOP_FRAME_TYPE.handshakeInit
      : REMOTE_DESKTOP_FRAME_TYPE.handshakeAck;

  const out = new Uint8Array(HANDSHAKE_FRAME_BYTES);
  out[0] = REMOTE_DESKTOP_CRYPTO_VERSION;
  out[1] = frameType;
  out.set(state.publicKey, 2);
  out.set(state.nonce, 34);
  out.set(mac, 50);
  return out;
}

export function isHandshakeFrame(frame: Uint8Array): boolean {
  return (
    frame.byteLength === HANDSHAKE_FRAME_BYTES &&
    frame[0] === REMOTE_DESKTOP_CRYPTO_VERSION &&
    (frame[1] === REMOTE_DESKTOP_FRAME_TYPE.handshakeInit ||
      frame[1] === REMOTE_DESKTOP_FRAME_TYPE.handshakeAck)
  );
}

export interface DecodedEncryptedFrame {
  readonly frameType: RemoteDesktopFrameType;
  readonly epoch: number;
  readonly seq: number;
  readonly payload: Uint8Array;
}

function buildNonce(directionByte: number, epoch: number, seq: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  nonce[0] = directionByte;
  nonce[1] = (epoch >>> 16) & 0xff;
  nonce[2] = (epoch >>> 8) & 0xff;
  nonce[3] = epoch & 0xff;
  view.setBigUint64(4, BigInt(seq), false);
  return nonce;
}

function buildHeader(frameType: RemoteDesktopFrameType, epoch: number, seq: number): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  header[0] = REMOTE_DESKTOP_CRYPTO_VERSION;
  header[1] = frameType;
  view.setUint32(2, epoch >>> 0, false);
  view.setBigUint64(6, BigInt(seq), false);
  return header;
}

async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  const copy = new Uint8Array(rawKey.byteLength);
  copy.set(rawKey);
  return globalThis.crypto.subtle.importKey("raw", copy, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export class RemoteDesktopCryptoSession {
  readonly role: RemoteDesktopPeerRole;
  readonly roomId: string;
  private readonly roomIdBytes: Uint8Array;
  private readonly sendDirection: number;
  private readonly recvDirection: number;
  private readonly sendKey: CryptoKey;
  private readonly recvKey: CryptoKey;
  private readonly epoch: number;
  private sendSeq = 1;
  private highestRecvSeq = 0;

  private constructor(params: {
    readonly role: RemoteDesktopPeerRole;
    readonly roomId: string;
    readonly sendKey: CryptoKey;
    readonly recvKey: CryptoKey;
    readonly epoch: number;
  }) {
    this.role = params.role;
    this.roomId = params.roomId;
    this.roomIdBytes = hexToBytes(params.roomId);
    this.sendDirection =
      params.role === "host" ? DIRECTION_HOST_TO_VIEWER : DIRECTION_VIEWER_TO_HOST;
    this.recvDirection =
      params.role === "host" ? DIRECTION_VIEWER_TO_HOST : DIRECTION_HOST_TO_VIEWER;
    this.sendKey = params.sendKey;
    this.recvKey = params.recvKey;
    this.epoch = params.epoch;
  }

  /**
   * Verifies the peer's PSK-authenticated ephemeral handshake frame and derives
   * forward-secret AES-256-GCM directional session keys via X25519 + HKDF-SHA256.
   */
  static async establish(params: {
    readonly localState: EphemeralHandshakeState;
    readonly peerHandshakeFrame: Uint8Array;
    readonly masterKey: string;
    readonly epoch?: number;
  }): Promise<RemoteDesktopCryptoSession> {
    const { localState, peerHandshakeFrame, masterKey } = params;
    const expectedPeerRole: RemoteDesktopPeerRole = localState.role === "host" ? "viewer" : "host";
    const expectedFrameType =
      expectedPeerRole === "viewer"
        ? REMOTE_DESKTOP_FRAME_TYPE.handshakeInit
        : REMOTE_DESKTOP_FRAME_TYPE.handshakeAck;

    if (peerHandshakeFrame.byteLength !== HANDSHAKE_FRAME_BYTES) {
      throw new Error("Invalid handshake frame length");
    }
    if (peerHandshakeFrame[0] !== REMOTE_DESKTOP_CRYPTO_VERSION) {
      throw new Error(`Unsupported handshake protocol version: ${peerHandshakeFrame[0]}`);
    }
    if (peerHandshakeFrame[1] !== expectedFrameType) {
      throw new Error("Unexpected handshake frame type for peer role");
    }

    const peerPublicKey = peerHandshakeFrame.subarray(2, 34);
    const peerNonce = peerHandshakeFrame.subarray(34, 50);
    const peerMac = peerHandshakeFrame.subarray(50, 82);

    const keyBytes = decodeRemoteDesktopMasterKey(masterKey);
    const pskAuthKey = hkdf(sha256, keyBytes, SALT_V1, INFO_PSK_AUTH, 32);
    const expectedMac = hmac(
      sha256,
      pskAuthKey,
      handshakeTranscript(localState.roomId, expectedPeerRole, peerPublicKey, peerNonce),
    );

    if (!timingSafeEqualBytes(peerMac, expectedMac)) {
      throw new Error("E2EE handshake authentication failed: master key mismatch or MITM detected");
    }

    const ecdhSecret = x25519.getSharedSecret(localState.privateKey, peerPublicKey);
    const hostNonce = localState.role === "host" ? localState.nonce : peerNonce;
    const viewerNonce = localState.role === "viewer" ? localState.nonce : peerNonce;
    const sessionSalt = sha256(concatBytes(hostNonce, viewerNonce, hexToBytes(localState.roomId)));
    const ikm = concatBytes(ecdhSecret, keyBytes);

    const h2vRaw = hkdf(sha256, ikm, sessionSalt, INFO_KEY_H2V, 32);
    const v2hRaw = hkdf(sha256, ikm, sessionSalt, INFO_KEY_V2H, 32);

    const [h2vKey, v2hKey] = await Promise.all([importAesGcmKey(h2vRaw), importAesGcmKey(v2hRaw)]);

    return new RemoteDesktopCryptoSession({
      role: localState.role,
      roomId: localState.roomId,
      sendKey: localState.role === "host" ? h2vKey : v2hKey,
      recvKey: localState.role === "host" ? v2hKey : h2vKey,
      epoch: params.epoch ?? 1,
    });
  }

  async encryptFrame(
    frameType: RemoteDesktopFrameType,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    const seq = this.sendSeq;
    this.sendSeq += 1;
    const header = buildHeader(frameType, this.epoch, seq);
    const iv = buildNonce(this.sendDirection, this.epoch, seq);
    const additionalData = concatBytes(header, this.roomIdBytes);
    const plaintextCopy = new Uint8Array(plaintext.byteLength);
    plaintextCopy.set(plaintext);
    const ivCopy = new Uint8Array(iv.byteLength);
    ivCopy.set(iv);
    const aadCopy = new Uint8Array(additionalData.byteLength);
    aadCopy.set(additionalData);

    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: ivCopy,
          additionalData: aadCopy,
          tagLength: 128,
        },
        this.sendKey,
        plaintextCopy,
      ),
    );
    return concatBytes(header, ciphertext);
  }

  async encryptJson(frameType: RemoteDesktopFrameType, value: unknown): Promise<Uint8Array> {
    return this.encryptFrame(frameType, textEncoder.encode(JSON.stringify(value)));
  }

  async decryptFrame(frame: Uint8Array): Promise<DecodedEncryptedFrame> {
    if (frame.byteLength < HEADER_BYTES + 16) {
      throw new Error("Encrypted frame is truncated");
    }
    const version = frame[0]!;
    if (version !== REMOTE_DESKTOP_CRYPTO_VERSION) {
      throw new Error(`Unsupported encrypted frame version: ${version}`);
    }
    const frameType = frame[1]! as RemoteDesktopFrameType;
    const header = frame.subarray(0, HEADER_BYTES);
    const view = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES);
    const epoch = view.getUint32(2, false);
    const seqBigInt = view.getBigUint64(6, false);
    if (seqBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Encrypted frame sequence number overflow");
    }
    const seq = Number(seqBigInt);
    if (epoch !== this.epoch) {
      throw new Error(`Unexpected encryption epoch: ${epoch}`);
    }
    if (seq <= this.highestRecvSeq) {
      throw new Error(`Replay or out-of-order encrypted frame rejected (seq=${seq})`);
    }

    const iv = buildNonce(this.recvDirection, epoch, seq);
    const additionalData = concatBytes(header, this.roomIdBytes);
    const ciphertext = frame.subarray(HEADER_BYTES);
    const ciphertextCopy = new Uint8Array(ciphertext.byteLength);
    ciphertextCopy.set(ciphertext);
    const ivCopy = new Uint8Array(iv.byteLength);
    ivCopy.set(iv);
    const aadCopy = new Uint8Array(additionalData.byteLength);
    aadCopy.set(additionalData);

    const plaintext = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ivCopy,
          additionalData: aadCopy,
          tagLength: 128,
        },
        this.recvKey,
        ciphertextCopy,
      ),
    );
    this.highestRecvSeq = seq;
    return { frameType, epoch, seq, payload: plaintext };
  }
}

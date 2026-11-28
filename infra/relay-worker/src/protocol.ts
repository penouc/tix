const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const RELAY_PROTOCOL_VERSION = 1;
export const MAX_PEER_ID_LENGTH = 64;
export const ROOM_ID_PATTERN = /^[a-f0-9]{32,128}$/i;
export const AUTH_HASH_PATTERN = /^[a-f0-9]{32,128}$/i;
export const PEER_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;

export interface RelayRoutedBinaryFrame {
  readonly peerId: string;
  readonly payload: Uint8Array;
}

/**
 * Wraps an opaque encrypted payload with a 1-byte length-prefixed peer routing tag.
 * The relay only inspects this outer routing prefix and never parses or decrypts `payload`.
 */
export function encodeRelayRoutedFrame(peerId: string, payload: Uint8Array): Uint8Array {
  const idBytes = textEncoder.encode(peerId);
  if (idBytes.byteLength === 0 || idBytes.byteLength > MAX_PEER_ID_LENGTH) {
    throw new Error(`Invalid relay routing peerId length: ${idBytes.byteLength}`);
  }
  const out = new Uint8Array(1 + idBytes.byteLength + payload.byteLength);
  out[0] = idBytes.byteLength;
  out.set(idBytes, 1);
  out.set(payload, 1 + idBytes.byteLength);
  return out;
}

export function decodeRelayRoutedFrame(raw: Uint8Array): RelayRoutedBinaryFrame | null {
  if (raw.byteLength < 2) return null;
  const idLen = raw[0]!;
  if (idLen === 0 || idLen > MAX_PEER_ID_LENGTH || raw.byteLength < 1 + idLen) {
    return null;
  }
  const peerId = textDecoder.decode(raw.subarray(1, 1 + idLen));
  const payload = raw.subarray(1 + idLen);
  return { peerId, payload };
}

export function timingSafeEqualAscii(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  const maxLen = Math.max(aBytes.byteLength, bBytes.byteLength);
  let diff = aBytes.byteLength ^ bBytes.byteLength;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

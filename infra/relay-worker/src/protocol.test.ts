import { describe, expect, it } from "vite-plus/test";
import {
  AUTH_HASH_PATTERN,
  PEER_ID_PATTERN,
  ROOM_ID_PATTERN,
  decodeRelayRoutedFrame,
  encodeRelayRoutedFrame,
  timingSafeEqualAscii,
} from "./protocol.ts";

describe("relay-worker protocol", () => {
  it("round-trips routed binary frames without modifying encrypted payload", () => {
    const payload = new Uint8Array([0x01, 0x02, 0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const encoded = encodeRelayRoutedFrame("viewer-abc_123", payload);
    const decoded = decodeRelayRoutedFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.peerId).toBe("viewer-abc_123");
    expect(Array.from(decoded?.payload ?? [])).toEqual(Array.from(payload));
  });

  it("rejects malformed routed binary frames", () => {
    expect(decodeRelayRoutedFrame(new Uint8Array([]))).toBeNull();
    expect(decodeRelayRoutedFrame(new Uint8Array([0]))).toBeNull();
    expect(decodeRelayRoutedFrame(new Uint8Array([10, 65, 66]))).toBeNull();
  });

  it("validates room ids, auth hashes, and peer ids", () => {
    expect(ROOM_ID_PATTERN.test("a".repeat(64))).toBe(true);
    expect(ROOM_ID_PATTERN.test("not-hex!")).toBe(false);
    expect(AUTH_HASH_PATTERN.test("0123456789abcdef".repeat(4))).toBe(true);
    expect(PEER_ID_PATTERN.test("viewer_1234-abcd")).toBe(true);
    expect(PEER_ID_PATTERN.test("../escape")).toBe(false);
  });

  it("compares tokens in constant time", () => {
    expect(timingSafeEqualAscii("secret-token-123", "secret-token-123")).toBe(true);
    expect(timingSafeEqualAscii("secret-token-123", "secret-token-124")).toBe(false);
    expect(timingSafeEqualAscii("short", "longer-token")).toBe(false);
  });
});

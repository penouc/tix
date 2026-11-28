import { describe, expect, it } from "vite-plus/test";
import {
  REMOTE_DESKTOP_FRAME_TYPE,
  RemoteDesktopCryptoSession,
  createHandshakeState,
  decodeRemoteDesktopPairingUri,
  deriveRemoteDesktopRelayIdentity,
  encodeHandshakeFrame,
  encodeRemoteDesktopPairingUri,
  generateRemoteDesktopMasterKey,
  normalizeRelayHttpUrl,
  toRelayWebSocketUrl,
} from "./remoteDesktopCrypto.ts";

describe("remoteDesktopCrypto", () => {
  it("derives deterministic zero-knowledge relay identity and fingerprint", () => {
    const masterKey = generateRemoteDesktopMasterKey();
    const id1 = deriveRemoteDesktopRelayIdentity(masterKey);
    const id2 = deriveRemoteDesktopRelayIdentity(masterKey);

    expect(id1).toEqual(id2);
    expect(id1.roomId).toMatch(/^[a-f0-9]{64}$/);
    expect(id1.roomAuthHash).toMatch(/^[a-f0-9]{64}$/);
    expect(id1.roomId).not.toBe(id1.roomAuthHash);
    expect(id1.fingerprint).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  });

  it("round-trips pairing URI with master key stored in URL fragment", () => {
    const masterKey = generateRemoteDesktopMasterKey();
    const uri = encodeRemoteDesktopPairingUri({
      relayUrl: "relay.penglei.dev/",
      masterKey,
      label: "MacBook Pro",
      relayAccessToken: "op-token-123",
    });

    expect(uri).toContain("relay=https%3A%2F%2Frelay.penglei.dev");
    expect(uri).toContain("#k=");
    expect(uri.split("#")[0]).not.toContain(masterKey);

    const parsed = decodeRemoteDesktopPairingUri(uri);
    expect(parsed).toEqual({
      relayUrl: "https://relay.penglei.dev",
      masterKey,
      label: "MacBook Pro",
      relayAccessToken: "op-token-123",
    });
  });

  it("normalizes relay URLs and constructs WebSocket endpoints", () => {
    expect(normalizeRelayHttpUrl("relay.penglei.dev/")).toBe("https://relay.penglei.dev");
    expect(normalizeRelayHttpUrl("wss://relay.penglei.dev")).toBe("https://relay.penglei.dev");

    const wsUrl = toRelayWebSocketUrl("https://relay.penglei.dev", "a".repeat(64), {
      role: "viewer",
      authHash: "b".repeat(64),
      peerId: "viewer-1234",
      accessToken: "secret",
    });
    expect(wsUrl).toBe(
      `wss://relay.penglei.dev/r/${"a".repeat(64)}/ws?role=viewer&auth=${"b".repeat(64)}&peerId=viewer-1234&token=secret`,
    );
  });

  it("establishes forward-secret E2EE session and protects against tampering and replay", async () => {
    const masterKey = generateRemoteDesktopMasterKey();
    const { roomId } = deriveRemoteDesktopRelayIdentity(masterKey);

    const viewerHs = createHandshakeState("viewer", roomId);
    const hostHs = createHandshakeState("host", roomId);

    const viewerInitFrame = encodeHandshakeFrame(viewerHs, masterKey);
    const hostAckFrame = encodeHandshakeFrame(hostHs, masterKey);

    const [hostSession, viewerSession] = await Promise.all([
      RemoteDesktopCryptoSession.establish({
        localState: hostHs,
        peerHandshakeFrame: viewerInitFrame,
        masterKey,
      }),
      RemoteDesktopCryptoSession.establish({
        localState: viewerHs,
        peerHandshakeFrame: hostAckFrame,
        masterKey,
      }),
    ]);

    const videoPayload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xe0, 0x1e]);
    const encryptedVideo = await hostSession.encryptFrame(
      REMOTE_DESKTOP_FRAME_TYPE.videoH264,
      videoPayload,
    );
    const decryptedVideo = await viewerSession.decryptFrame(encryptedVideo);
    expect(decryptedVideo.frameType).toBe(REMOTE_DESKTOP_FRAME_TYPE.videoH264);
    expect(Array.from(decryptedVideo.payload)).toEqual(Array.from(videoPayload));

    // Replay of the exact same encrypted frame must be rejected.
    await expect(viewerSession.decryptFrame(encryptedVideo)).rejects.toThrow(/Replay/i);

    // Tampering with ciphertext or header AAD must fail GCM authentication.
    const encryptedInput = await viewerSession.encryptJson(REMOTE_DESKTOP_FRAME_TYPE.inputJson, {
      type: "mouse_click",
      x: 0.5,
      y: 0.5,
    });
    const tampered = new Uint8Array(encryptedInput);
    const lastIdx = tampered.byteLength - 1;
    tampered[lastIdx] = (tampered[lastIdx] ?? 0) ^ 0xff;
    await expect(hostSession.decryptFrame(tampered)).rejects.toThrow();

    // Valid frame still succeeds after rejecting tampered frame.
    const decryptedInput = await hostSession.decryptFrame(encryptedInput);
    expect(JSON.parse(new TextDecoder().decode(decryptedInput.payload))).toEqual({
      type: "mouse_click",
      x: 0.5,
      y: 0.5,
    });
  });

  it("rejects MITM handshake signed with a wrong master key", async () => {
    const hostKey = generateRemoteDesktopMasterKey();
    const attackerKey = generateRemoteDesktopMasterKey();
    const { roomId } = deriveRemoteDesktopRelayIdentity(hostKey);

    const attackerHs = createHandshakeState("viewer", roomId);
    const hostHs = createHandshakeState("host", roomId);

    const forgedInit = encodeHandshakeFrame(attackerHs, attackerKey);
    await expect(
      RemoteDesktopCryptoSession.establish({
        localState: hostHs,
        peerHandshakeFrame: forgedInit,
        masterKey: hostKey,
      }),
    ).rejects.toThrow(/authentication failed/i);
  });
});

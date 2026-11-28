import { describe, expect, it } from "vite-plus/test";
import { H264AnnexBSplitter, JpegStreamSplitter } from "./ScreenCaptureDriver.ts";

describe("JpegStreamSplitter", () => {
  it("extracts multiple JPEG frames split across arbitrary chunks", () => {
    const frames: Array<Uint8Array> = [];
    const splitter = new JpegStreamSplitter((frame) => frames.push(frame));

    const frame1 = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
    const frame2 = new Uint8Array([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    const combined = new Uint8Array([0x00, 0x11, ...frame1, ...frame2.subarray(0, 3)]);

    splitter.push(combined);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!)).toEqual(Array.from(frame1));

    splitter.push(frame2.subarray(3));
    expect(frames).toHaveLength(2);
    expect(Array.from(frames[1]!)).toEqual(Array.from(frame2));
  });
});

describe("H264AnnexBSplitter", () => {
  it("caches SPS/PPS, derives RFC 6381 codec string, and emits keyframe + delta access units", () => {
    const units: Array<{
      readonly isKeyframe: boolean;
      readonly codecString: string;
      readonly bytes: Uint8Array;
    }> = [];
    const splitter = new H264AnnexBSplitter((unit) => units.push(unit));

    // SPS (type 7): profile=0x4d (Main), constraints=0x40, level=0x28 (4.0) -> avc1.4d4028
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x4d, 0x40, 0x28, 0x9a]);
    // PPS (type 8)
    const pps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0x80]);
    // IDR keyframe slice (type 5)
    const idr = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x01, 0x02]);
    // Non-IDR P-frame slice (type 1) using 3-byte start code
    const pFrame = new Uint8Array([0x00, 0x00, 0x01, 0x41, 0x9a, 0x22, 0x33]);

    const stream = new Uint8Array([...sps, ...pps, ...idr, ...pFrame]);
    // Feed in fragmented chunks to test incremental Annex-B parsing.
    splitter.push(stream.subarray(0, 11));
    splitter.push(stream.subarray(11, 24));
    splitter.push(stream.subarray(24));
    splitter.flush();

    expect(units).toHaveLength(2);
    expect(units[0]?.isKeyframe).toBe(true);
    expect(units[0]?.codecString).toBe("avc1.4d4028");
    // Keyframe must include SPS + PPS + IDR.
    expect(units[0]?.bytes.byteLength).toBe(sps.byteLength + pps.byteLength + idr.byteLength);

    expect(units[1]?.isKeyframe).toBe(false);
    expect(units[1]?.codecString).toBe("avc1.4d4028");
  });
});

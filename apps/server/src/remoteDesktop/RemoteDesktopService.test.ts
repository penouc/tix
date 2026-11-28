import { describe, expect, it } from "vite-plus/test";
import { JpegStreamSplitter } from "./ScreenCaptureDriver.ts";

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

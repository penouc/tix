// @effect-diagnostics nodeBuiltinImport:off -- OS screen capture spawns system binaries and streams raw encoded frames from stdout.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  RemoteDesktopCodec,
  RemoteDesktopDisplay,
  RemoteDesktopQualityPreset,
} from "@t3tools/contracts";

export type CaptureBackendKind = "ffmpeg-h264" | "screencapture-jpeg" | "unavailable";
export type H264EncoderKind = "h264_videotoolbox" | "h264_nvenc" | "h264_mf" | "libx264";

export interface CaptureOptions {
  readonly display: RemoteDesktopDisplay;
  readonly quality: RemoteDesktopQualityPreset;
  readonly maxFps: number;
  readonly preferredCodec: RemoteDesktopCodec;
}

export type CapturedFrame =
  | {
      readonly codec: "h264";
      readonly isKeyframe: boolean;
      readonly codecString: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly codec: "jpeg";
      readonly isKeyframe: true;
      readonly bytes: Uint8Array;
    };

export interface CaptureSessionHandle {
  readonly backend: CaptureBackendKind;
  readonly codec: RemoteDesktopCodec;
  readonly stop: () => void;
}

const QUALITY_PROFILES: Record<
  RemoteDesktopQualityPreset,
  {
    readonly maxWidth: number;
    readonly qscale: number;
    readonly defaultFps: number;
    readonly bitrateKbps: number;
    readonly maxBitrateKbps: number;
  }
> = {
  smooth: { maxWidth: 1280, qscale: 10, defaultFps: 30, bitrateKbps: 1200, maxBitrateKbps: 1800 },
  auto: { maxWidth: 1600, qscale: 7, defaultFps: 30, bitrateKbps: 2200, maxBitrateKbps: 3200 },
  hd: { maxWidth: 1920, qscale: 5, defaultFps: 45, bitrateKbps: 3500, maxBitrateKbps: 5000 },
  ultra: { maxWidth: 2560, qscale: 3, defaultFps: 60, bitrateKbps: 6000, maxBitrateKbps: 8500 },
};

const MAC_SCREENCAPTURE_PATH = "/usr/sbin/screencapture";
const START_CODE_4 = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

let cachedH264Encoder: H264EncoderKind | null | undefined;

function commandExistsSync(platform: NodeJS.Platform, command: string): boolean {
  const probe = platform === "win32" ? "where" : "which";
  const result = NodeChildProcess.spawnSync(probe, [command], {
    stdio: "ignore",
    timeout: 3000,
  });
  return result.status === 0;
}

export function detectCaptureBackend(platform: NodeJS.Platform): CaptureBackendKind {
  if (commandExistsSync(platform, "ffmpeg")) {
    return "ffmpeg-h264";
  }
  if (platform === "darwin" && NodeFS.existsSync(MAC_SCREENCAPTURE_PATH)) {
    return "screencapture-jpeg";
  }
  return "unavailable";
}

export function detectH264Encoder(platform: NodeJS.Platform): H264EncoderKind | null {
  if (cachedH264Encoder !== undefined) return cachedH264Encoder;
  const probe = NodeChildProcess.spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    encoding: "utf8",
    timeout: 4000,
  });
  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  const candidates: ReadonlyArray<H264EncoderKind> =
    platform === "darwin"
      ? ["h264_videotoolbox", "libx264"]
      : platform === "win32"
        ? ["h264_nvenc", "h264_mf", "libx264"]
        : ["h264_nvenc", "libx264"];
  for (const candidate of candidates) {
    if (output.includes(candidate)) {
      cachedH264Encoder = candidate;
      return candidate;
    }
  }
  cachedH264Encoder = null;
  return null;
}

function execFileText(
  file: string,
  args: ReadonlyArray<string>,
  timeoutMs = 4000,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly ok: boolean }> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(file, [...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        ok: error === null,
      });
    });
  });
}

const FALLBACK_DISPLAY: RemoteDesktopDisplay = {
  id: "display-0",
  index: 0,
  name: "Primary Display",
  width: 1920,
  height: 1080,
  scaleFactor: 1,
  isPrimary: true,
};

export async function listHostDisplays(
  platform: NodeJS.Platform,
): Promise<ReadonlyArray<RemoteDesktopDisplay>> {
  if (platform === "darwin") {
    const jxa =
      'ObjC.import("AppKit");' +
      "const screens = $.NSScreen.screens;" +
      "const out = [];" +
      "for (let i = 0; i < screens.count; i++) {" +
      "  const s = screens.objectAtIndex(i);" +
      "  const f = s.frame;" +
      '  const name = s.localizedName ? ObjC.unwrap(s.localizedName) : ("Display " + (i + 1));' +
      "  out.push({ id: 'display-' + i, index: i, name: String(name), width: Math.max(1, Math.round(f.size.width)), height: Math.max(1, Math.round(f.size.height)), scaleFactor: Number(s.backingScaleFactor || 1), isPrimary: i === 0 });" +
      "}" +
      "JSON.stringify(out);";
    const result = await execFileText("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa]);
    if (result.ok && result.stdout.trim()) {
      try {
        const parsed = JSON.parse(result.stdout.trim()) as Array<RemoteDesktopDisplay>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Fall through to default display.
      }
    }
    return [FALLBACK_DISPLAY];
  }

  if (platform === "linux") {
    const result = await execFileText("xrandr", ["--query"]);
    if (result.ok) {
      const displays: Array<RemoteDesktopDisplay> = [];
      const regex = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(\d+)\+(\d+)/gm;
      let match = regex.exec(result.stdout);
      let index = 0;
      while (match !== null) {
        displays.push({
          id: `display-${index}`,
          index,
          name: match[1] ?? `Display ${index + 1}`,
          width: Number.parseInt(match[3] ?? "1920", 10) || 1920,
          height: Number.parseInt(match[4] ?? "1080", 10) || 1080,
          scaleFactor: 1,
          isPrimary: Boolean(match[2]) || index === 0,
        });
        index += 1;
        match = regex.exec(result.stdout);
      }
      if (displays.length > 0) return displays;
    }
    return [FALLBACK_DISPLAY];
  }

  if (platform === "win32") {
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$i=0; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { " +
      "[PSCustomObject]@{ id=('display-' + $i); index=$i; name=$_.DeviceName; width=$_.Bounds.Width; height=$_.Bounds.Height; scaleFactor=1; isPrimary=$_.Primary }; $i++ " +
      "} | ConvertTo-Json -Compress";
    const result = await execFileText("powershell.exe", ["-NoProfile", "-Command", ps]);
    if (result.ok && result.stdout.trim()) {
      try {
        const raw = JSON.parse(result.stdout.trim());
        const list = Array.isArray(raw) ? raw : [raw];
        if (list.length > 0) return list as ReadonlyArray<RemoteDesktopDisplay>;
      } catch {
        // Fall through.
      }
    }
  }

  return [FALLBACK_DISPLAY];
}

async function discoverMacAvFoundationScreenIndices(): Promise<ReadonlyArray<number>> {
  const result = await execFileText("ffmpeg", [
    "-f",
    "avfoundation",
    "-list_devices",
    "true",
    "-i",
    "",
  ]);
  const combined = `${result.stdout}\n${result.stderr}`;
  const indices: Array<number> = [];
  const regex = /\[(\d+)\]\s+Capture screen\s+(\d+)/gi;
  let match = regex.exec(combined);
  while (match !== null) {
    const devIndex = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(devIndex)) {
      indices.push(devIndex);
    }
    match = regex.exec(combined);
  }
  return indices;
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
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

/**
 * Parses an H.264 Annex-B elementary stream from ffmpeg stdout into self-contained
 * WebCodecs-ready Access Units, caching SPS/PPS so every IDR keyframe carries full decoder config.
 */
export class H264AnnexBSplitter {
  private buffer: Uint8Array = new Uint8Array(0);
  private latestSps: Uint8Array | null = null;
  private latestPps: Uint8Array | null = null;
  private codecString = "avc1.4d4028";
  private readonly onAccessUnit: (unit: {
    readonly isKeyframe: boolean;
    readonly codecString: string;
    readonly bytes: Uint8Array;
  }) => void;

  constructor(
    onAccessUnit: (unit: {
      readonly isKeyframe: boolean;
      readonly codecString: string;
      readonly bytes: Uint8Array;
    }) => void,
  ) {
    this.onAccessUnit = onAccessUnit;
  }

  private findStartCode(
    data: Uint8Array,
    from: number,
  ): { readonly index: number; readonly length: number } | null {
    for (let i = from; i <= data.byteLength - 3; i += 1) {
      if (data[i] === 0x00 && data[i + 1] === 0x00) {
        if (data[i + 2] === 0x01) {
          return { index: i, length: 3 };
        }
        if (i + 3 < data.byteLength && data[i + 2] === 0x00 && data[i + 3] === 0x01) {
          return { index: i, length: 4 };
        }
      }
    }
    return null;
  }

  private handleNalUnit(nal: Uint8Array): void {
    if (nal.byteLength === 0) return;
    const nalType = nal[0]! & 0x1f;

    if (nalType === 7) {
      this.latestSps = nal;
      if (nal.byteLength >= 4) {
        const p = nal[1]!.toString(16).padStart(2, "0");
        const c = nal[2]!.toString(16).padStart(2, "0");
        const l = nal[3]!.toString(16).padStart(2, "0");
        this.codecString = `avc1.${p}${c}${l}`;
      }
      return;
    }

    if (nalType === 8) {
      this.latestPps = nal;
      return;
    }

    if (nalType === 5) {
      if (!this.latestSps || !this.latestPps) return;
      const bytes = concatBytes([
        START_CODE_4,
        this.latestSps,
        START_CODE_4,
        this.latestPps,
        START_CODE_4,
        nal,
      ]);
      this.onAccessUnit({
        isKeyframe: true,
        codecString: this.codecString,
        bytes,
      });
      return;
    }

    if (nalType === 1) {
      const bytes = concatBytes([START_CODE_4, nal]);
      this.onAccessUnit({
        isKeyframe: false,
        codecString: this.codecString,
        bytes,
      });
    }
  }

  push(chunk: Uint8Array): void {
    const combined = this.buffer.byteLength === 0 ? chunk : concatBytes([this.buffer, chunk]);

    let first = this.findStartCode(combined, 0);
    if (!first) {
      this.buffer = combined.byteLength > 3 ? combined.slice(combined.byteLength - 3) : combined;
      return;
    }

    let cursor = first.index;
    let scLen = first.length;
    while (true) {
      const next = this.findStartCode(combined, cursor + scLen);
      if (!next) {
        this.buffer = combined.slice(cursor);
        return;
      }
      const nal = combined.slice(cursor + scLen, next.index);
      this.handleNalUnit(nal);
      cursor = next.index;
      scLen = next.length;
    }
  }

  flush(): void {
    const first = this.findStartCode(this.buffer, 0);
    if (first && first.index + first.length < this.buffer.byteLength) {
      this.handleNalUnit(this.buffer.slice(first.index + first.length));
    }
    this.buffer = new Uint8Array(0);
  }
}

/**
 * Extracts complete JPEG frames (SOI 0xFFD8 .. EOI 0xFFD9) from an ffmpeg image2pipe stdout stream.
 */
export class JpegStreamSplitter {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly onFrame: (frame: Uint8Array) => void;

  constructor(onFrame: (frame: Uint8Array) => void) {
    this.onFrame = onFrame;
  }

  push(chunk: Uint8Array): void {
    const combined = this.buffer.byteLength === 0 ? chunk : concatBytes([this.buffer, chunk]);

    let searchStart = 0;
    while (searchStart < combined.byteLength - 1) {
      let soi = -1;
      for (let i = searchStart; i < combined.byteLength - 1; i += 1) {
        if (combined[i] === 0xff && combined[i + 1] === 0xd8) {
          soi = i;
          break;
        }
      }
      if (soi === -1) {
        this.buffer = new Uint8Array(0);
        return;
      }

      let eoi = -1;
      for (let i = soi + 2; i < combined.byteLength - 1; i += 1) {
        if (combined[i] === 0xff && combined[i + 1] === 0xd9) {
          eoi = i + 2;
          break;
        }
      }
      if (eoi === -1) {
        this.buffer = combined.slice(soi);
        return;
      }

      const frame = combined.slice(soi, eoi);
      this.onFrame(frame);
      searchStart = eoi;
    }

    this.buffer =
      searchStart < combined.byteLength ? combined.slice(searchStart) : new Uint8Array(0);
  }
}

async function buildFfmpegInputArgs(
  platform: NodeJS.Platform,
  display: RemoteDesktopDisplay,
  fps: number,
): Promise<Array<string>> {
  if (platform === "darwin") {
    const screenIndices = await discoverMacAvFoundationScreenIndices();
    const targetScreen = screenIndices[display.index] ?? screenIndices[0] ?? 1;
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-f",
      "avfoundation",
      "-capture_cursor",
      "1",
      "-framerate",
      String(fps),
      "-i",
      `${targetScreen}:none`,
    ];
  }
  if (platform === "win32") {
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-f",
      "gdigrab",
      "-framerate",
      String(fps),
      "-draw_mouse",
      "1",
      "-i",
      "desktop",
    ];
  }
  const displayEnv = process.env.DISPLAY || ":0";
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-f",
    "x11grab",
    "-framerate",
    String(fps),
    "-i",
    displayEnv,
  ];
}

function buildH264EncoderArgs(
  encoder: H264EncoderKind,
  fps: number,
  bitrateKbps: number,
  maxBitrateKbps: number,
): Array<string> {
  const gop = String(Math.max(15, fps * 2));
  const common = [
    "-pix_fmt",
    "yuv420p",
    "-g",
    gop,
    "-bf",
    "0",
    "-b:v",
    `${bitrateKbps}k`,
    "-maxrate",
    `${maxBitrateKbps}k`,
    "-bufsize",
    `${bitrateKbps}k`,
  ];

  if (encoder === "h264_videotoolbox") {
    return [
      "-c:v",
      "h264_videotoolbox",
      "-realtime",
      "1",
      "-allow_sw",
      "1",
      "-profile:v",
      "main",
      ...common,
      "-f",
      "h264",
      "-",
    ];
  }
  if (encoder === "h264_nvenc") {
    return [
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p1",
      "-tune",
      "ull",
      "-zerolatency",
      "1",
      "-profile:v",
      "main",
      ...common,
      "-f",
      "h264",
      "-",
    ];
  }
  if (encoder === "h264_mf") {
    return [
      "-c:v",
      "h264_mf",
      "-rate_control",
      "cbr",
      "-scenario",
      "display_remoting",
      ...common,
      "-f",
      "h264",
      "-",
    ];
  }
  return [
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "main",
    ...common,
    "-f",
    "h264",
    "-",
  ];
}

export async function startScreenCapture(
  platform: NodeJS.Platform,
  options: CaptureOptions,
  callbacks: {
    readonly onFrame: (frame: CapturedFrame) => void;
    readonly onError: (message: string) => void;
  },
): Promise<CaptureSessionHandle> {
  const profile = QUALITY_PROFILES[options.quality];
  const fps = Math.max(5, Math.min(options.maxFps, profile.defaultFps));
  const backend = detectCaptureBackend(platform);

  if (backend === "ffmpeg-h264") {
    const encoder = options.preferredCodec === "h264" ? detectH264Encoder(platform) : null;
    const useH264 = encoder !== null;
    const inputArgs = await buildFfmpegInputArgs(platform, options.display, fps);
    // H.264 yuv420p requires even width and height.
    const scaleFilter = `scale='trunc(min(${profile.maxWidth},iw)/2)*2':'trunc(ih*min(${profile.maxWidth},iw)/iw/2)*2'`;
    const outputArgs = useH264
      ? [
          "-vf",
          scaleFilter,
          ...buildH264EncoderArgs(encoder, fps, profile.bitrateKbps, profile.maxBitrateKbps),
        ]
      : [
          "-vf",
          `scale='min(${profile.maxWidth},iw)':-2`,
          "-c:v",
          "mjpeg",
          "-q:v",
          String(profile.qscale),
          "-f",
          "image2pipe",
          "-",
        ];

    const args = [...inputArgs, ...outputArgs];
    let stopped = false;
    let receivedFrame = false;
    let fallbackHandle: CaptureSessionHandle | null = null;
    const child = NodeChildProcess.spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const h264Splitter = useH264
      ? new H264AnnexBSplitter((unit) => {
          receivedFrame = true;
          if (!stopped) {
            callbacks.onFrame({
              codec: "h264",
              isKeyframe: unit.isKeyframe,
              codecString: unit.codecString,
              bytes: unit.bytes,
            });
          }
        })
      : null;

    const jpegSplitter = !useH264
      ? new JpegStreamSplitter((bytes) => {
          receivedFrame = true;
          if (!stopped) {
            callbacks.onFrame({ codec: "jpeg", isKeyframe: true, bytes });
          }
        })
      : null;

    let stderrTail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (h264Splitter) h264Splitter.push(bytes);
      else jpegSplitter?.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-500);
    });
    child.on("exit", (code) => {
      if (stopped) return;
      // If hardware H.264 failed before producing a single frame, seamlessly fall back to MJPEG.
      if (!receivedFrame && useH264) {
        void startScreenCapture(platform, { ...options, preferredCodec: "jpeg" }, callbacks).then(
          (handle) => {
            if (stopped) handle.stop();
            else fallbackHandle = handle;
          },
        );
        return;
      }
      if (!receivedFrame && platform === "darwin" && NodeFS.existsSync(MAC_SCREENCAPTURE_PATH)) {
        fallbackHandle = startMacScreenCaptureFallback(options, Math.min(fps, 12), callbacks);
        return;
      }
      if (code !== 0) {
        callbacks.onError(
          stderrTail.trim() ||
            `Screen capture exited with code ${String(code)}. Check OS Screen Recording permissions.`,
        );
      }
    });
    child.on("error", (err) => {
      if (!stopped) callbacks.onError(err.message);
    });

    return {
      backend: "ffmpeg-h264",
      codec: useH264 ? "h264" : "jpeg",
      stop: () => {
        stopped = true;
        fallbackHandle?.stop();
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      },
    };
  }

  if (backend === "screencapture-jpeg") {
    return startMacScreenCaptureFallback(options, Math.min(fps, 12), callbacks);
  }

  callbacks.onError(
    "No supported screen capture backend found. Install ffmpeg on the host machine.",
  );
  return {
    backend: "unavailable",
    codec: "jpeg",
    stop: () => {},
  };
}

function startMacScreenCaptureFallback(
  options: CaptureOptions,
  fps: number,
  callbacks: {
    readonly onFrame: (frame: CapturedFrame) => void;
    readonly onError: (message: string) => void;
  },
): CaptureSessionHandle {
  let stopped = false;
  const intervalMs = Math.max(80, Math.round(1000 / Math.max(1, fps)));
  const tempPath = NodePath.join(
    NodeOS.tmpdir(),
    `tix-rd-frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
  );

  const isStopped = () => stopped;

  const loop = async () => {
    while (!isStopped()) {
      const startedAt = Date.now();
      const result = await execFileText(
        MAC_SCREENCAPTURE_PATH,
        ["-x", "-C", "-D", String(options.display.index + 1), "-t", "jpg", tempPath],
        5000,
      );
      if (isStopped()) break;
      if (result.ok) {
        try {
          const bytes = await NodeFSP.readFile(tempPath);
          if (!isStopped() && bytes.byteLength > 4) {
            callbacks.onFrame({
              codec: "jpeg",
              isKeyframe: true,
              bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            });
          }
        } catch {
          // Ignore transient read race.
        }
      } else {
        callbacks.onError(
          result.stderr.trim() ||
            "macOS screencapture failed. Grant Screen Recording permission to TiX in System Settings.",
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed < intervalMs) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs - elapsed));
      }
    }
    await NodeFSP.rm(tempPath, { force: true }).catch(() => {});
  };

  void loop();

  return {
    backend: "screencapture-jpeg",
    codec: "jpeg",
    stop: () => {
      stopped = true;
    },
  };
}

// @effect-diagnostics nodeBuiltinImport:off -- OS screen capture spawns system binaries and streams raw frames from stdout.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { RemoteDesktopDisplay, RemoteDesktopQualityPreset } from "@t3tools/contracts";

export type CaptureBackendKind = "ffmpeg-h264" | "screencapture-jpeg" | "unavailable";

export interface CaptureOptions {
  readonly display: RemoteDesktopDisplay;
  readonly quality: RemoteDesktopQualityPreset;
  readonly maxFps: number;
}

export interface CaptureSessionHandle {
  readonly backend: CaptureBackendKind;
  readonly stop: () => void;
}

const QUALITY_PROFILES: Record<
  RemoteDesktopQualityPreset,
  { readonly maxWidth: number; readonly qscale: number; readonly defaultFps: number }
> = {
  smooth: { maxWidth: 1024, qscale: 10, defaultFps: 18 },
  auto: { maxWidth: 1440, qscale: 7, defaultFps: 24 },
  hd: { maxWidth: 1920, qscale: 5, defaultFps: 30 },
  ultra: { maxWidth: 2560, qscale: 3, defaultFps: 45 },
};

const MAC_SCREENCAPTURE_PATH = "/usr/sbin/screencapture";

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
    const combined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.byteLength);

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

export async function startScreenCapture(
  platform: NodeJS.Platform,
  options: CaptureOptions,
  callbacks: {
    readonly onFrame: (jpegBytes: Uint8Array) => void;
    readonly onError: (message: string) => void;
  },
): Promise<CaptureSessionHandle> {
  const profile = QUALITY_PROFILES[options.quality];
  const fps = Math.max(5, Math.min(options.maxFps, profile.defaultFps));
  const backend = detectCaptureBackend(platform);

  if (backend === "ffmpeg-h264") {
    let args: Array<string>;
    if (platform === "darwin") {
      const screenIndices = await discoverMacAvFoundationScreenIndices();
      const targetScreen = screenIndices[options.display.index] ?? screenIndices[0] ?? 1;
      args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "avfoundation",
        "-capture_cursor",
        "1",
        "-framerate",
        String(fps),
        "-i",
        `${targetScreen}:none`,
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
    } else if (platform === "win32") {
      args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "gdigrab",
        "-framerate",
        String(fps),
        "-draw_mouse",
        "1",
        "-i",
        "desktop",
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
    } else {
      const displayEnv = process.env.DISPLAY || ":0";
      args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-framerate",
        String(fps),
        "-i",
        displayEnv,
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
    }

    let stopped = false;
    let receivedFrame = false;
    let fallbackHandle: CaptureSessionHandle | null = null;
    const child = NodeChildProcess.spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const splitter = new JpegStreamSplitter((frame) => {
      receivedFrame = true;
      if (!stopped) callbacks.onFrame(frame);
    });
    let stderrTail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (!stopped) splitter.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-500);
    });
    child.on("exit", (code) => {
      if (stopped) return;
      if (!receivedFrame && platform === "darwin" && NodeFS.existsSync(MAC_SCREENCAPTURE_PATH)) {
        fallbackHandle = startMacScreenCaptureFallback(options, fps, callbacks);
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
    stop: () => {},
  };
}

function startMacScreenCaptureFallback(
  options: CaptureOptions,
  fps: number,
  callbacks: {
    readonly onFrame: (jpegBytes: Uint8Array) => void;
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
            callbacks.onFrame(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
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
    stop: () => {
      stopped = true;
    },
  };
}

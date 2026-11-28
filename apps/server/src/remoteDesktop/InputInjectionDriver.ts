// @effect-diagnostics nodeBuiltinImport:off -- OS input injection runs in an isolated child process boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { RemoteDesktopDisplay, RemoteDesktopInputEvent } from "@t3tools/contracts";

export type InputBackendKind =
  | "macos-cgevent"
  | "win32-sendinput"
  | "linux-xdotool"
  | "unavailable";

function commandExistsSync(platform: NodeJS.Platform, command: string): boolean {
  const probe = platform === "win32" ? "where" : "which";
  const result = NodeChildProcess.spawnSync(probe, [command], {
    stdio: "ignore",
    timeout: 3000,
  });
  return result.status === 0;
}

export function detectInputBackend(platform: NodeJS.Platform): InputBackendKind {
  if (platform === "darwin") {
    return "macos-cgevent";
  }
  if (platform === "win32") {
    return "win32-sendinput";
  }
  if (platform === "linux" && commandExistsSync(platform, "xdotool")) {
    return "linux-xdotool";
  }
  return "unavailable";
}

const MACOS_SWIFT_INPUT_HELPER_SOURCE = String.raw`
import Foundation
import CoreGraphics

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
  "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
  "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "enter": 36, "return": 36,
  "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
  "m": 46, ".": 47, "tab": 48, " ": 49, "space": 49, "\u{60}": 50, "backquote": 50, "backspace": 51,
  "escape": 53, "esc": 53, "meta": 55, "cmd": 55, "command": 55, "shift": 56,
  "capslock": 57, "alt": 58, "option": 58, "ctrl": 59, "control": 59,
  "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103,
  "f10": 109, "f12": 111, "home": 115, "pageup": 116, "delete": 117,
  "f4": 118, "end": 119, "f2": 120, "pagedown": 121, "f1": 122,
  "arrowleft": 123, "left": 123, "arrowright": 124, "right": 124,
  "arrowdown": 125, "down": 125, "arrowup": 126, "up": 126
]

func modifierFlags(_ mods: [String]?) -> CGEventFlags {
  var flags: CGEventFlags = []
  for m in mods ?? [] {
    switch m.lowercased() {
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    case "meta", "cmd", "command": flags.insert(.maskCommand)
    default: break
    }
  }
  return flags
}

func postMouse(type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) {
  guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
  event.setIntegerValueField(.mouseEventClickState, value: clickState)
  event.post(tap: .cghidEventTap)
}

func handleCommand(_ dict: [String: Any]) {
  guard let type = dict["type"] as? String else { return }
  switch type {
  case "mouse_move":
    let x = dict["px"] as? Double ?? 0
    let y = dict["py"] as? Double ?? 0
    postMouse(type: .mouseMoved, point: CGPoint(x: x, y: y), button: .left)
  case "mouse_button":
    let x = dict["px"] as? Double ?? 0
    let y = dict["py"] as? Double ?? 0
    let btnStr = dict["button"] as? String ?? "left"
    let action = dict["action"] as? String ?? "click"
    let pt = CGPoint(x: x, y: y)
    let btn: CGMouseButton = btnStr == "right" ? .right : (btnStr == "middle" ? .center : .left)
    let downType: CGEventType = btnStr == "right" ? .rightMouseDown : (btnStr == "middle" ? .otherMouseDown : .leftMouseDown)
    let upType: CGEventType = btnStr == "right" ? .rightMouseUp : (btnStr == "middle" ? .otherMouseUp : .leftMouseUp)
    if action == "down" {
      postMouse(type: downType, point: pt, button: btn)
    } else if action == "up" {
      postMouse(type: upType, point: pt, button: btn)
    } else if action == "double_click" {
      postMouse(type: downType, point: pt, button: btn, clickState: 1)
      postMouse(type: upType, point: pt, button: btn, clickState: 1)
      postMouse(type: downType, point: pt, button: btn, clickState: 2)
      postMouse(type: upType, point: pt, button: btn, clickState: 2)
    } else {
      postMouse(type: downType, point: pt, button: btn, clickState: 1)
      postMouse(type: upType, point: pt, button: btn, clickState: 1)
    }
  case "mouse_scroll":
    let dx = Int32(dict["deltaX"] as? Double ?? 0)
    let dy = Int32(dict["deltaY"] as? Double ?? 0)
    if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) {
      event.post(tap: .cghidEventTap)
    }
  case "key":
    let keyStr = (dict["key"] as? String ?? "").lowercased()
    let action = dict["action"] as? String ?? "press"
    let flags = modifierFlags(dict["modifiers"] as? [String])
    if let code = keyCodes[keyStr] {
      if action == "down" || action == "press" {
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
          down.flags = flags
          down.post(tap: .cghidEventTap)
        }
      }
      if action == "up" || action == "press" {
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
          up.flags = flags
          up.post(tap: .cghidEventTap)
        }
      }
    }
  case "text":
    let text = dict["text"] as? String ?? ""
    let utf16 = Array(text.utf16)
    if !utf16.isEmpty {
      if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
         let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
      }
    }
  default:
    break
  }
}

while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
  handleCommand(obj)
}
`;

export class InputInjectionDriver {
  private readonly stateDir: string;
  private readonly platform: NodeJS.Platform;
  private macHelperProcess: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private macHelperReadyPromise: Promise<string | null> | null = null;

  constructor(stateDir: string, platform: NodeJS.Platform) {
    this.stateDir = stateDir;
    this.platform = platform;
  }

  private ensureMacSwiftHelperBinary(): Promise<string | null> {
    if (this.macHelperReadyPromise) return this.macHelperReadyPromise;
    this.macHelperReadyPromise = (async () => {
      if (!commandExistsSync(this.platform, "swiftc")) return null;
      const dir = NodePath.join(this.stateDir, "remote-desktop");
      const srcPath = NodePath.join(dir, "macos-input-helper.swift");
      const binPath = NodePath.join(dir, "macos-input-helper-v1");
      if (NodeFS.existsSync(binPath)) return binPath;
      await NodeFSP.mkdir(dir, { recursive: true });
      await NodeFSP.writeFile(srcPath, MACOS_SWIFT_INPUT_HELPER_SOURCE, "utf8");
      const compiled = await new Promise<boolean>((resolve) => {
        NodeChildProcess.execFile(
          "swiftc",
          ["-O", srcPath, "-o", binPath],
          { timeout: 30_000 },
          (error) => resolve(error === null),
        );
      });
      return compiled ? binPath : null;
    })();
    return this.macHelperReadyPromise;
  }

  private async ensureMacHelperProcess(): Promise<NodeChildProcess.ChildProcessWithoutNullStreams | null> {
    if (
      this.macHelperProcess &&
      !this.macHelperProcess.killed &&
      this.macHelperProcess.exitCode === null
    ) {
      return this.macHelperProcess;
    }
    const binPath = await this.ensureMacSwiftHelperBinary();
    if (!binPath) return null;
    const child = NodeChildProcess.spawn(binPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("exit", () => {
      if (this.macHelperProcess === child) {
        this.macHelperProcess = null;
      }
    });
    this.macHelperProcess = child;
    return child;
  }

  async dispatch(event: RemoteDesktopInputEvent, display: RemoteDesktopDisplay): Promise<void> {
    if (
      event.type === "set_display" ||
      event.type === "set_quality" ||
      event.type === "request_keyframe"
    ) {
      return;
    }

    const toPx = (nx: number, ny: number) => ({
      px: Math.round(Math.max(0, Math.min(1, nx)) * Math.max(1, display.width - 1)),
      py: Math.round(Math.max(0, Math.min(1, ny)) * Math.max(1, display.height - 1)),
    });

    if (this.platform === "darwin") {
      const helper = await this.ensureMacHelperProcess();
      if (helper) {
        let payload: Record<string, unknown>;
        if (event.type === "mouse_move") {
          payload = { type: "mouse_move", ...toPx(event.x, event.y) };
        } else if (event.type === "mouse_button") {
          payload = {
            type: "mouse_button",
            button: event.button,
            action: event.action,
            ...toPx(event.x, event.y),
          };
        } else if (event.type === "mouse_scroll") {
          payload = { type: "mouse_scroll", deltaX: event.deltaX, deltaY: event.deltaY };
        } else if (event.type === "key") {
          payload = {
            type: "key",
            action: event.action,
            key: event.key,
            modifiers: event.modifiers ?? [],
          };
        } else {
          payload = { type: "text", text: event.text };
        }
        helper.stdin.write(`${JSON.stringify(payload)}\n`);
      }
      return;
    }

    if (this.platform === "linux" && commandExistsSync(this.platform, "xdotool")) {
      const run = (args: ReadonlyArray<string>) =>
        new Promise<void>((resolve) => {
          NodeChildProcess.execFile("xdotool", [...args], { timeout: 2000 }, () => resolve());
        });

      if (event.type === "mouse_move") {
        const { px, py } = toPx(event.x, event.y);
        await run(["mousemove", "--sync", String(px), String(py)]);
      } else if (event.type === "mouse_button") {
        const { px, py } = toPx(event.x, event.y);
        const btn = event.button === "right" ? "3" : event.button === "middle" ? "2" : "1";
        await run(["mousemove", "--sync", String(px), String(py)]);
        if (event.action === "down") await run(["mousedown", btn]);
        else if (event.action === "up") await run(["mouseup", btn]);
        else if (event.action === "double_click") await run(["click", "--repeat", "2", btn]);
        else await run(["click", btn]);
      } else if (event.type === "mouse_scroll") {
        const btn = event.deltaY > 0 ? "5" : "4";
        const steps = Math.max(1, Math.min(8, Math.round(Math.abs(event.deltaY) / 40)));
        await run(["click", "--repeat", String(steps), btn]);
      } else if (event.type === "key") {
        const combo = [...(event.modifiers ?? []), event.key].join("+");
        await run([
          event.action === "down" ? "keydown" : event.action === "up" ? "keyup" : "key",
          combo,
        ]);
      } else if (event.type === "text") {
        await run(["type", "--clearmodifiers", "--", event.text]);
      }
      return;
    }

    if (this.platform === "win32") {
      if (event.type === "mouse_move" || event.type === "mouse_button") {
        const { px, py } = toPx(event.x, event.y);
        const flag =
          event.type === "mouse_move"
            ? ""
            : event.button === "right"
              ? event.action === "down"
                ? "[Win32Input]::mouse_event(0x0008,0,0,0,0);"
                : event.action === "up"
                  ? "[Win32Input]::mouse_event(0x0010,0,0,0,0);"
                  : "[Win32Input]::mouse_event(0x0008,0,0,0,0);[Win32Input]::mouse_event(0x0010,0,0,0,0);"
              : event.action === "down"
                ? "[Win32Input]::mouse_event(0x0002,0,0,0,0);"
                : event.action === "up"
                  ? "[Win32Input]::mouse_event(0x0004,0,0,0,0);"
                  : "[Win32Input]::mouse_event(0x0002,0,0,0,0);[Win32Input]::mouse_event(0x0004,0,0,0,0);";
        const ps =
          'Add-Type -MemberDefinition "[DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);" -Name Win32Input -Namespace Native; ' +
          `[Native.Win32Input]::SetCursorPos(${px}, ${py}) | Out-Null; ${flag.replaceAll("[Win32Input]", "[Native.Win32Input]")}`;
        await new Promise<void>((resolve) => {
          NodeChildProcess.execFile(
            "powershell.exe",
            ["-NoProfile", "-Command", ps],
            { timeout: 2000 },
            () => resolve(),
          );
        });
      }
    }
  }

  dispose(): void {
    if (this.macHelperProcess && !this.macHelperProcess.killed) {
      this.macHelperProcess.kill("SIGTERM");
    }
    this.macHelperProcess = null;
  }
}

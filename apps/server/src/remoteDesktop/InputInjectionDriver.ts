// @effect-diagnostics nodeBuiltinImport:off -- OS input injection runs in an isolated persistent child process boundary.

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

/**
 * Persistent PowerShell stdin loop for Windows (< 2ms input latency, zero per-event spawn).
 */
const WIN32_PERSISTENT_INPUT_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class TixWinInput {",
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  "  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
  "  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }",
  "  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }",
  '  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
  "  public static void SendUnicode(string text) {",
  "    foreach (char ch in text) {",
  "      INPUT[] inputs = new INPUT[2];",
  "      inputs[0].type = 1; inputs[0].u.ki.wScan = (ushort)ch; inputs[0].u.ki.dwFlags = 0x0004;",
  "      inputs[1].type = 1; inputs[1].u.ki.wScan = (ushort)ch; inputs[1].u.ki.dwFlags = 0x0004 | 0x0002;",
  "      SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));",
  "    }",
  "  }",
  "}",
  "'@",
  "$vkMap = @{ backspace=0x08; tab=0x09; enter=0x0D; return=0x0D; shift=0x10; ctrl=0x11; control=0x11; alt=0x12; escape=0x1B; esc=0x1B; space=0x20; ' '=0x20; pageup=0x21; pagedown=0x22; end=0x23; home=0x24; arrowleft=0x25; left=0x25; arrowup=0x26; up=0x26; arrowright=0x27; right=0x27; arrowdown=0x28; down=0x28; delete=0x2E; meta=0x5B; cmd=0x5B }",
  "while ($null -ne ($line = [Console]::In.ReadLine())) {",
  "  if (-not $line) { continue }",
  "  try { $cmd = $line | ConvertFrom-Json } catch { continue }",
  "  switch ($cmd.type) {",
  "    'mouse_move' { [TixWinInput]::SetCursorPos([int]$cmd.px, [int]$cmd.py) | Out-Null }",
  "    'mouse_button' {",
  "      [TixWinInput]::SetCursorPos([int]$cmd.px, [int]$cmd.py) | Out-Null",
  "      $down = if ($cmd.button -eq 'right') { 0x0008 } elseif ($cmd.button -eq 'middle') { 0x0020 } else { 0x0002 }",
  "      $up = if ($cmd.button -eq 'right') { 0x0010 } elseif ($cmd.button -eq 'middle') { 0x0040 } else { 0x0004 }",
  "      if ($cmd.action -eq 'down') { [TixWinInput]::mouse_event($down,0,0,0,[UIntPtr]::Zero) }",
  "      elseif ($cmd.action -eq 'up') { [TixWinInput]::mouse_event($up,0,0,0,[UIntPtr]::Zero) }",
  "      elseif ($cmd.action -eq 'double_click') { [TixWinInput]::mouse_event($down,0,0,0,[UIntPtr]::Zero); [TixWinInput]::mouse_event($up,0,0,0,[UIntPtr]::Zero); [TixWinInput]::mouse_event($down,0,0,0,[UIntPtr]::Zero); [TixWinInput]::mouse_event($up,0,0,0,[UIntPtr]::Zero) }",
  "      else { [TixWinInput]::mouse_event($down,0,0,0,[UIntPtr]::Zero); [TixWinInput]::mouse_event($up,0,0,0,[UIntPtr]::Zero) }",
  "    }",
  "    'mouse_scroll' {",
  "      $dy = [int](-$cmd.deltaY)",
  "      if ($dy -ne 0) { [TixWinInput]::mouse_event(0x0800, 0, 0, $dy, [UIntPtr]::Zero) }",
  "    }",
  "    'key' {",
  "      $k = ([string]$cmd.key).ToLower()",
  "      $vk = if ($vkMap.ContainsKey($k)) { [byte]$vkMap[$k] } elseif ($k.Length -eq 1) { [byte][char]$k.ToUpper() } else { 0 }",
  "      if ($vk -ne 0) {",
  "        $mods = @()",
  "        foreach ($m in ($cmd.modifiers | ForEach-Object { ([string]$_).ToLower() })) {",
  "          if ($vkMap.ContainsKey($m)) { $mods += [byte]$vkMap[$m] }",
  "        }",
  "        foreach ($mv in $mods) { [TixWinInput]::keybd_event($mv, 0, 0, [UIntPtr]::Zero) }",
  "        [TixWinInput]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)",
  "        [TixWinInput]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)",
  "        for ($i = $mods.Count - 1; $i -ge 0; $i--) { [TixWinInput]::keybd_event($mods[$i], 0, 2, [UIntPtr]::Zero) }",
  "      }",
  "    }",
  "    'text' { if ($cmd.text) { [TixWinInput]::SendUnicode([string]$cmd.text) } }",
  "  }",
  "}",
].join("\n");

export class InputInjectionDriver {
  private readonly stateDir: string;
  private readonly platform: NodeJS.Platform;
  private macHelperProcess: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private macHelperReadyPromise: Promise<string | null> | null = null;
  private winHelperProcess: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private linuxXdotoolProcess: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;

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

  private ensureWinHelperProcess(): NodeChildProcess.ChildProcessWithoutNullStreams {
    if (
      this.winHelperProcess &&
      !this.winHelperProcess.killed &&
      this.winHelperProcess.exitCode === null
    ) {
      return this.winHelperProcess;
    }
    const child = NodeChildProcess.spawn(
      "powershell.exe",
      ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", WIN32_PERSISTENT_INPUT_SCRIPT],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.on("exit", () => {
      if (this.winHelperProcess === child) {
        this.winHelperProcess = null;
      }
    });
    this.winHelperProcess = child;
    return child;
  }

  private ensureLinuxXdotoolProcess(): NodeChildProcess.ChildProcessWithoutNullStreams | null {
    if (!commandExistsSync(this.platform, "xdotool")) return null;
    if (
      this.linuxXdotoolProcess &&
      !this.linuxXdotoolProcess.killed &&
      this.linuxXdotoolProcess.exitCode === null
    ) {
      return this.linuxXdotoolProcess;
    }
    const child = NodeChildProcess.spawn("xdotool", ["-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("exit", () => {
      if (this.linuxXdotoolProcess === child) {
        this.linuxXdotoolProcess = null;
      }
    });
    this.linuxXdotoolProcess = child;
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

    const buildJsonPayload = (): Record<string, unknown> => {
      if (event.type === "mouse_move") {
        return { type: "mouse_move", ...toPx(event.x, event.y) };
      }
      if (event.type === "mouse_button") {
        return {
          type: "mouse_button",
          button: event.button,
          action: event.action,
          ...toPx(event.x, event.y),
        };
      }
      if (event.type === "mouse_scroll") {
        return { type: "mouse_scroll", deltaX: event.deltaX, deltaY: event.deltaY };
      }
      if (event.type === "key") {
        return {
          type: "key",
          action: event.action,
          key: event.key,
          modifiers: event.modifiers ?? [],
        };
      }
      return { type: "text", text: event.text };
    };

    if (this.platform === "darwin") {
      const helper = await this.ensureMacHelperProcess();
      if (helper) {
        helper.stdin.write(`${JSON.stringify(buildJsonPayload())}\n`);
      }
      return;
    }

    if (this.platform === "win32") {
      const helper = this.ensureWinHelperProcess();
      helper.stdin.write(`${JSON.stringify(buildJsonPayload())}\n`);
      return;
    }

    if (this.platform === "linux") {
      const helper = this.ensureLinuxXdotoolProcess();
      if (!helper) return;
      if (event.type === "mouse_move") {
        const { px, py } = toPx(event.x, event.y);
        helper.stdin.write(`mousemove ${px} ${py}\n`);
      } else if (event.type === "mouse_button") {
        const { px, py } = toPx(event.x, event.y);
        const btn = event.button === "right" ? "3" : event.button === "middle" ? "2" : "1";
        helper.stdin.write(`mousemove ${px} ${py}\n`);
        if (event.action === "down") helper.stdin.write(`mousedown ${btn}\n`);
        else if (event.action === "up") helper.stdin.write(`mouseup ${btn}\n`);
        else if (event.action === "double_click") helper.stdin.write(`click --repeat 2 ${btn}\n`);
        else helper.stdin.write(`click ${btn}\n`);
      } else if (event.type === "mouse_scroll") {
        const btn = event.deltaY > 0 ? "5" : "4";
        const steps = Math.max(1, Math.min(8, Math.round(Math.abs(event.deltaY) / 40)));
        helper.stdin.write(`click --repeat ${steps} ${btn}\n`);
      } else if (event.type === "key") {
        const combo = [...(event.modifiers ?? []), event.key].join("+");
        const verb = event.action === "down" ? "keydown" : event.action === "up" ? "keyup" : "key";
        helper.stdin.write(`${verb} ${combo}\n`);
      } else if (event.type === "text") {
        const escaped = event.text.replaceAll("\n", " ");
        helper.stdin.write(`type --clearmodifiers -- ${escaped}\n`);
      }
    }
  }

  dispose(): void {
    for (const child of [this.macHelperProcess, this.winHelperProcess, this.linuxXdotoolProcess]) {
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
    }
    this.macHelperProcess = null;
    this.winHelperProcess = null;
    this.linuxXdotoolProcess = null;
  }
}

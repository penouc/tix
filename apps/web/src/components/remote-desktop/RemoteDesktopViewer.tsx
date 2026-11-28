import {
  buildDirectRemoteDesktopWsUrl,
  createRemoteDesktopClient,
  type RemoteDesktopClientHandle,
  type RemoteDesktopClientStats,
  type RemoteDesktopClientStatus,
  type RemoteDesktopSessionInfo,
} from "@t3tools/client-runtime/remote-desktop/client";
import type { RemoteDesktopQualityPreset } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  KeyboardIcon,
  LockIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  MousePointer2Icon,
  RadioIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  TouchpadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface RemoteDesktopViewerProps {
  readonly title: string;
  readonly directOrigin?: string | null;
  readonly directWsPath?: string | null;
  readonly directTicket?: string | null;
  readonly relayUrl?: string | null;
  readonly relayAccessToken?: string | null;
  readonly masterKey: string;
  readonly initialAllowControl: boolean;
  readonly initialFingerprint?: string | null;
  readonly onClose: () => void;
}

type InputInteractionMode = "direct" | "touchpad";

const QUICK_SHORTCUTS: ReadonlyArray<{
  readonly label: string;
  readonly key: string;
  readonly modifiers?: ReadonlyArray<"ctrl" | "alt" | "shift" | "meta">;
}> = [
  { label: "Esc", key: "escape" },
  { label: "Tab", key: "tab" },
  { label: "⌘␣", key: "space", modifiers: ["meta"] },
  { label: "⌘C", key: "c", modifiers: ["meta"] },
  { label: "⌘V", key: "v", modifiers: ["meta"] },
  { label: "⌘Z", key: "z", modifiers: ["meta"] },
  { label: "⌘⇥", key: "tab", modifiers: ["meta"] },
  { label: "⌃C", key: "c", modifiers: ["ctrl"] },
  { label: "↵", key: "enter" },
  { label: "⌫", key: "backspace" },
];

export function RemoteDesktopViewer(props: RemoteDesktopViewerProps) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<RemoteDesktopClientHandle | null>(null);
  const lastMoveSentAtRef = useRef(0);
  const cursorPosRef = useRef({ x: 0.5, y: 0.5 });
  const touchStateRef = useRef<{
    lastX: number;
    lastY: number;
    moved: boolean;
    startedAt: number;
    fingerCount: number;
  } | null>(null);

  const [status, setStatus] = useState<RemoteDesktopClientStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<RemoteDesktopSessionInfo | null>(null);
  const [stats, setStats] = useState<RemoteDesktopClientStats>({
    fps: 0,
    rttMs: null,
    bitrateKbps: 0,
    codec: "h264",
    transport: props.directOrigin && props.directTicket ? "direct" : "relay",
    encrypted: false,
    width: 1920,
    height: 1080,
  });

  const [viewOnly, setViewOnly] = useState(!props.initialAllowControl);
  const [inputMode, setInputMode] = useState<InputInteractionMode>("direct");
  const [transportPreference, setTransportPreference] = useState<"auto" | "direct" | "relay">(
    "auto",
  );
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [keyboardTrayOpen, setKeyboardTrayOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [virtualCursor, setVirtualCursor] = useState<{ x: number; y: number } | null>(null);

  const canControl = !viewOnly && (sessionInfo?.allowControl ?? props.initialAllowControl);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes the live external WebSocket streaming client lifecycle.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const peerId = `w_${Math.random().toString(36).slice(2, 12)}`;
    const directWsUrl =
      props.directOrigin && props.directWsPath && props.directTicket
        ? buildDirectRemoteDesktopWsUrl(
            props.directOrigin,
            props.directWsPath,
            props.directTicket,
            peerId,
          )
        : null;

    const handle = createRemoteDesktopClient(
      {
        directWsUrl,
        relayUrl: props.relayUrl ?? null,
        relayAccessToken: props.relayAccessToken ?? null,
        masterKey: props.masterKey,
        transportPreference: "auto",
      },
      canvas,
      {
        onStatus: (nextStatus, detail) => {
          setStatus(nextStatus);
          if (detail) setStatusDetail(detail);
          else if (nextStatus === "streaming") setStatusDetail("");
        },
        onSessionInfo: (info) => {
          setSessionInfo(info);
          setCaptureError(null);
          if (!info.allowControl) {
            setViewOnly(true);
          }
        },
        onStats: (nextStats) => {
          setStats(nextStats);
        },
        onCaptureError: (message) => {
          setCaptureError(message);
        },
      },
    );

    clientRef.current = handle;
    return () => {
      handle.stop();
      clientRef.current = null;
    };
  }, [
    props.directOrigin,
    props.directWsPath,
    props.directTicket,
    props.relayUrl,
    props.relayAccessToken,
    props.masterKey,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes to the DOM fullscreenchange event.
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const normalizedPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0.5, y: 0.5 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  };

  const buttonFromPointer = (button: number): "left" | "right" | "middle" =>
    button === 2 ? "right" : button === 1 ? "middle" : "left";

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canControl || !clientRef.current) return;
    const now = performance.now();
    if (now - lastMoveSentAtRef.current < 16) return;
    lastMoveSentAtRef.current = now;

    if (inputMode === "touchpad" && event.pointerType === "touch") {
      const state = touchStateRef.current;
      if (!state) return;
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) state.moved = true;

      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const scaleW = rect && rect.width > 0 ? rect.width : 800;
      const scaleH = rect && rect.height > 0 ? rect.height : 600;
      const nx = Math.max(0, Math.min(1, cursorPosRef.current.x + (dx * 1.45) / scaleW));
      const ny = Math.max(0, Math.min(1, cursorPosRef.current.y + (dy * 1.45) / scaleH));
      cursorPosRef.current = { x: nx, y: ny };
      setVirtualCursor({ x: nx, y: ny });
      clientRef.current.sendInput({ type: "mouse_move", x: nx, y: ny });
      return;
    }

    const pt = normalizedPoint(event.clientX, event.clientY);
    cursorPosRef.current = pt;
    clientRef.current.sendInput({ type: "mouse_move", x: pt.x, y: pt.y });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.focus();
    if (!canControl || !clientRef.current) return;
    event.preventDefault();

    if (inputMode === "touchpad" && event.pointerType === "touch") {
      touchStateRef.current = {
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        startedAt: Date.now(),
        fingerCount: 1,
      };
      setVirtualCursor(cursorPosRef.current);
      return;
    }

    const pt = normalizedPoint(event.clientX, event.clientY);
    cursorPosRef.current = pt;
    clientRef.current.sendInput({
      type: "mouse_button",
      button: buttonFromPointer(event.button),
      action: "down",
      x: pt.x,
      y: pt.y,
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canControl || !clientRef.current) return;
    event.preventDefault();

    if (inputMode === "touchpad" && event.pointerType === "touch") {
      const state = touchStateRef.current;
      touchStateRef.current = null;
      if (state && !state.moved && Date.now() - state.startedAt < 280) {
        clientRef.current.sendInput({
          type: "mouse_button",
          button: "left",
          action: "click",
          x: cursorPosRef.current.x,
          y: cursorPosRef.current.y,
        });
      }
      return;
    }

    const pt = normalizedPoint(event.clientX, event.clientY);
    cursorPosRef.current = pt;
    clientRef.current.sendInput({
      type: "mouse_button",
      button: buttonFromPointer(event.button),
      action: "up",
      x: pt.x,
      y: pt.y,
    });
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!canControl || !clientRef.current) return;
    event.preventDefault();
    const pt = normalizedPoint(event.clientX, event.clientY);
    clientRef.current.sendInput({
      type: "mouse_scroll",
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      x: pt.x,
      y: pt.y,
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!canControl || !clientRef.current) return;
    event.preventDefault();
    event.stopPropagation();

    const modifiers: Array<"ctrl" | "alt" | "shift" | "meta"> = [];
    if (event.ctrlKey) modifiers.push("ctrl");
    if (event.altKey) modifiers.push("alt");
    if (event.shiftKey) modifiers.push("shift");
    if (event.metaKey) modifiers.push("meta");

    clientRef.current.sendInput({
      type: "key",
      action: "press",
      key: event.key.toLowerCase(),
      ...(modifiers.length > 0 ? { modifiers } : {}),
    });
  };

  const sendVirtualClick = (
    button: "left" | "right" | "middle",
    action: "click" | "double_click" = "click",
  ) => {
    if (!canControl || !clientRef.current) return;
    clientRef.current.sendInput({
      type: "mouse_button",
      button,
      action,
      x: cursorPosRef.current.x,
      y: cursorPosRef.current.y,
    });
  };

  const sendTextDraft = () => {
    const value = textDraft;
    if (!value || !canControl || !clientRef.current) return;
    clientRef.current.sendInput({ type: "text", text: value });
    setTextDraft("");
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  };

  const handleTransportChange = (next: "auto" | "direct" | "relay") => {
    setTransportPreference(next);
    clientRef.current?.reconnect(next);
  };

  const handleQualityChange = (quality: RemoteDesktopQualityPreset) => {
    clientRef.current?.setQuality(quality);
  };

  const fingerprint = sessionInfo?.fingerprint ?? props.initialFingerprint ?? null;
  const displays = sessionInfo?.displays ?? [];
  const activeQuality = sessionInfo?.quality ?? "hd";
  const transportLabel = stats.transport === "relay" ? gt("Relay") : gt("Direct");
  const codecLabel = stats.codec === "h264" ? "H.264" : "JPEG";
  const bitrateLabel =
    stats.bitrateKbps >= 1000
      ? `${(stats.bitrateKbps / 1000).toFixed(1)}Mbps`
      : `${stats.bitrateKbps}kbps`;
  const hudStatsText =
    status === "streaming"
      ? `${transportLabel} · ${codecLabel} · ${stats.fps}fps · ${bitrateLabel}${stats.rttMs !== null ? ` · ${stats.rttMs}ms` : ""}`
      : transportLabel;

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground select-none"
    >
      {/* UU-style floating collapsible HUD pill */}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-full border border-border bg-popover/90 px-3 py-1.5 text-xs text-popover-foreground shadow-2xl backdrop-blur-md">
          <div className="flex items-center gap-1.5 pr-1 font-medium">
            <MonitorIcon className="size-3.5 text-success" />
            <span className="max-w-36 truncate">{props.title}</span>
          </div>

          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-2xs text-success">
            <ShieldCheckIcon className="size-3" />
            <span>
              {fingerprint && !toolbarCollapsed ? `E2EE ${fingerprint.slice(0, 9)}` : "E2EE"}
            </span>
          </span>

          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-2xs text-muted-foreground">
            <RadioIcon className="size-3 text-info" />
            <span>{hudStatsText}</span>
          </span>

          {!toolbarCollapsed ? (
            <>
              <div className="mx-0.5 h-4 w-px bg-border" />

              {displays.length > 1 ? (
                <select
                  aria-label={gt("Select display")}
                  value={sessionInfo?.activeDisplayId ?? displays[0]?.id}
                  onChange={(e) => clientRef.current?.setDisplay(e.target.value)}
                  className="h-6 rounded-md border border-border bg-card px-1.5 text-2xs text-foreground outline-none"
                >
                  {displays.map((d) => (
                    <option key={d.id} value={d.id}>
                      {`${d.name} (${d.width}x${d.height})`}
                    </option>
                  ))}
                </select>
              ) : null}

              <select
                aria-label={gt("Stream quality")}
                value={activeQuality}
                onChange={(e) => handleQualityChange(e.target.value as RemoteDesktopQualityPreset)}
                className="h-6 rounded-md border border-border bg-card px-1.5 text-2xs text-foreground outline-none"
              >
                <option value="smooth">{gt("Smooth")}</option>
                <option value="auto">{gt("Auto")}</option>
                <option value="hd">{gt("HD")}</option>
                <option value="ultra">{gt("Ultra")}</option>
              </select>

              {props.directOrigin && props.directTicket && props.relayUrl ? (
                <select
                  aria-label={gt("Connection transport")}
                  value={transportPreference}
                  onChange={(e) =>
                    handleTransportChange(e.target.value as "auto" | "direct" | "relay")
                  }
                  className="h-6 rounded-md border border-border bg-card px-1.5 text-2xs text-foreground outline-none"
                >
                  <option value="auto">{gt("Auto")}</option>
                  <option value="direct">{gt("Direct")}</option>
                  <option value="relay">{gt("Cloudflare Relay")}</option>
                </select>
              ) : null}

              <Button
                size="xs"
                variant={canControl ? "secondary" : "warning-outline"}
                disabled={sessionInfo !== null && !sessionInfo.allowControl}
                onClick={() => setViewOnly((prev) => !prev)}
                aria-label={
                  canControl ? gt("Switch to view-only mode") : gt("Enable remote control")
                }
              >
                {canControl ? (
                  <>
                    <MousePointer2Icon className="size-3" />
                    <T>Control</T>
                  </>
                ) : (
                  <>
                    <EyeIcon className="size-3" />
                    <T>View only</T>
                  </>
                )}
              </Button>

              {canControl ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setInputMode((prev) => (prev === "direct" ? "touchpad" : "direct"))
                  }
                  aria-label={gt("Toggle touchpad or direct pointer mode")}
                >
                  <TouchpadIcon className="size-3" />
                  <span>{inputMode === "touchpad" ? gt("Touchpad") : gt("Direct")}</span>
                </Button>
              ) : null}

              {canControl ? (
                <Button
                  size="xs"
                  variant={keyboardTrayOpen ? "secondary" : "ghost"}
                  onClick={() => setKeyboardTrayOpen((prev) => !prev)}
                >
                  <KeyboardIcon className="size-3" />
                  <T>Shortcuts</T>
                </Button>
              ) : null}

              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => clientRef.current?.reconnect()}
                aria-label={gt("Reconnect")}
              >
                <RefreshCwIcon className="size-3" />
              </Button>

              <Button
                size="icon-xs"
                variant="ghost"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? gt("Exit fullscreen") : gt("Fullscreen")}
              >
                {isFullscreen ? (
                  <Minimize2Icon className="size-3" />
                ) : (
                  <Maximize2Icon className="size-3" />
                )}
              </Button>
            </>
          ) : null}

          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setToolbarCollapsed((prev) => !prev)}
            aria-label={toolbarCollapsed ? gt("Expand toolbar") : gt("Collapse toolbar")}
          >
            {toolbarCollapsed ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronUpIcon className="size-3.5" />
            )}
          </Button>

          <Button
            size="icon-xs"
            variant="ghost-destructive"
            onClick={props.onClose}
            aria-label={gt("Close remote desktop")}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Main Screen Stage */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onContextMenu={(e) => e.preventDefault()}
          className="max-h-full max-w-full cursor-crosshair object-contain outline-none"
          style={{ touchAction: "none" }}
        />

        {inputMode === "touchpad" && virtualCursor && canControl ? (
          <div
            className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-info shadow"
            style={{
              left: `${virtualCursor.x * 100}%`,
              top: `${virtualCursor.y * 100}%`,
            }}
          />
        ) : null}

        {status !== "streaming" || captureError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/75 backdrop-blur-xs">
            <div className="pointer-events-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-border bg-card px-6 py-5 text-center shadow-2xl">
              <div className="flex size-10 items-center justify-center rounded-full bg-success/15 text-success">
                <LockIcon className="size-5" />
              </div>
              <div className="text-sm font-medium text-foreground">
                {captureError ? (
                  <T>Screen capture permission required</T>
                ) : status === "waiting_host" ? (
                  <T>Waiting for host computer</T>
                ) : status === "error" ? (
                  <T>Connection failed</T>
                ) : status === "handshaking" ? (
                  <T>Verifying end-to-end encryption</T>
                ) : (
                  <T>Connecting to remote desktop</T>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {captureError ??
                  (statusDetail ||
                    gt("Establishing forward-secret X25519 + AES-256-GCM tunnel..."))}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => clientRef.current?.reconnect()}
                >
                  <RefreshCwIcon className="size-3.5" />
                  <T>Retry</T>
                </Button>
                <Button size="xs" variant="ghost" onClick={props.onClose}>
                  <T>Close</T>
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* UU-style Bottom Floating Keyboard & Mouse Action Tray */}
      {keyboardTrayOpen && canControl ? (
        <div className="z-20 flex flex-col gap-2 border-t border-border bg-popover/95 px-3 py-2.5 backdrop-blur-md">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="secondary" onClick={() => sendVirtualClick("left", "click")}>
              <T>Left click</T>
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => sendVirtualClick("left", "double_click")}
            >
              <T>Double click</T>
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => sendVirtualClick("right", "click")}
            >
              <T>Right click</T>
            </Button>
            <div className="mx-1 h-4 w-px bg-border" />
            {QUICK_SHORTCUTS.map((shortcut) => (
              <Button
                key={shortcut.label}
                size="xs"
                variant="outline"
                onClick={() =>
                  clientRef.current?.sendInput({
                    type: "key",
                    action: "press",
                    key: shortcut.key,
                    ...(shortcut.modifiers ? { modifiers: shortcut.modifiers } : {}),
                  })
                }
              >
                {shortcut.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendTextDraft();
                }
              }}
              placeholder={gt("Type text to send to the remote computer...")}
              className="flex-1"
            />
            <Button size="xs" onClick={sendTextDraft} disabled={!textDraft}>
              <SendIcon className="size-3" />
              <T>Send</T>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

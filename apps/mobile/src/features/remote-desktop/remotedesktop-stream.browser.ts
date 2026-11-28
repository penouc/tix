import {
  buildDirectRemoteDesktopWsUrl,
  createRemoteDesktopClient,
  type RemoteDesktopClientHandle,
} from "@t3tools/client-runtime/remote-desktop/client";
import type { RemoteDesktopInputEvent, RemoteDesktopQualityPreset } from "@t3tools/contracts";

import type { MobileRemoteDesktopConfiguration } from "./remote-desktop-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

let activeClient: RemoteDesktopClientHandle | null = null;
let viewOnly = false;
let hostAllowsControl = true;
let interactionMode: "touchpad" | "direct" = "touchpad";
let cursorX = 0.5;
let cursorY = 0.5;
let cursorDot: HTMLDivElement | null = null;

function canControl(): boolean {
  return !viewOnly && hostAllowsControl && activeClient !== null;
}

function updateCursorDot() {
  if (!cursorDot) return;
  if (interactionMode === "touchpad" && canControl()) {
    cursorDot.style.display = "block";
    cursorDot.style.left = `${cursorX * 100}%`;
    cursorDot.style.top = `${cursorY * 100}%`;
  } else {
    cursorDot.style.display = "none";
  }
}

export function stop() {
  activeClient?.stop();
  activeClient = null;
}

export function setInteractionMode(mode: "touchpad" | "direct") {
  interactionMode = mode;
  updateCursorDot();
}

export function setViewOnly(next: boolean) {
  viewOnly = next;
  updateCursorDot();
}

export function setDisplay(displayId: string) {
  activeClient?.setDisplay(displayId);
}

export function setQuality(quality: RemoteDesktopQualityPreset) {
  activeClient?.setQuality(quality);
}

export function reconnect(transport?: "auto" | "direct" | "relay") {
  activeClient?.reconnect(transport);
}

export function sendInput(event: RemoteDesktopInputEvent) {
  if (!canControl()) return;
  activeClient?.sendInput(event);
}

export function sendVirtualClick(
  button: "left" | "right" | "middle",
  action: "click" | "double_click" = "click",
) {
  if (!canControl()) return;
  activeClient?.sendInput({
    type: "mouse_button",
    button,
    action,
    x: cursorX,
    y: cursorY,
  });
}

export function start(configuration: MobileRemoteDesktopConfiguration) {
  stop();
  hostAllowsControl = configuration.initialAllowControl;
  viewOnly = !configuration.initialAllowControl;
  interactionMode = "touchpad";
  cursorX = 0.5;
  cursorY = 0.5;

  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- React Native WebView bridge takes one string argument.
  const post = (message: object) => window.ReactNativeWebView.postMessage(JSON.stringify(message));

  Object.assign(document.documentElement.style, {
    height: "100%",
    width: "100%",
    overflow: "hidden",
    background: "#000",
  });
  Object.assign(document.body.style, {
    margin: "0",
    height: "100%",
    width: "100%",
    overflow: "hidden",
    background: "#000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
  });

  const stage = document.createElement("div");
  Object.assign(stage.style, {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    touchAction: "none",
  });

  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    display: "block",
    touchAction: "none",
  });

  cursorDot = document.createElement("div");
  Object.assign(cursorDot.style, {
    position: "absolute",
    width: "14px",
    height: "14px",
    borderRadius: "9999px",
    border: "2px solid #fff",
    background: "rgba(56, 189, 248, 0.85)",
    boxShadow: "0 0 8px rgba(0,0,0,0.65)",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    display: "none",
  });

  stage.append(canvas, cursorDot);
  document.body.replaceChildren(stage);
  updateCursorDot();

  const peerId = `m_${Math.random().toString(36).slice(2, 12)}`;
  const directWsUrl =
    configuration.directOrigin && configuration.directWsPath && configuration.directTicket
      ? buildDirectRemoteDesktopWsUrl(
          configuration.directOrigin,
          configuration.directWsPath,
          configuration.directTicket,
          peerId,
        )
      : null;

  activeClient = createRemoteDesktopClient(
    {
      directWsUrl,
      relayUrl: configuration.relayUrl ?? null,
      relayAccessToken: configuration.relayAccessToken ?? null,
      masterKey: configuration.masterKey,
      transportPreference: "auto",
    },
    canvas,
    {
      onStatus: (status, detail) => post({ type: "status", status, detail }),
      onSessionInfo: (info) => {
        hostAllowsControl = info.allowControl;
        if (!info.allowControl) viewOnly = true;
        updateCursorDot();
        post({ type: "session_info", info });
      },
      onStats: (stats) => post({ type: "stats", stats }),
      onCaptureError: (message) => post({ type: "capture_error", message }),
    },
  );

  // UU-Remote-inspired mobile gesture handling (Touchpad + Direct Touch)
  let lastTouchX = 0;
  let lastTouchY = 0;
  let moved = false;
  let touchStartAt = 0;
  let lastTapAt = 0;
  let maxFingers = 0;
  let dragging = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMoveEmitAt = 0;

  const clearLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const toCanvasNorm = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  };

  stage.addEventListener(
    "touchstart",
    (event) => {
      if (!canControl()) return;
      event.preventDefault();
      clearLongPress();
      const t0 = event.touches[0];
      if (!t0) return;
      maxFingers = Math.max(maxFingers, event.touches.length);
      lastTouchX = t0.clientX;
      lastTouchY = t0.clientY;
      moved = false;
      dragging = false;
      touchStartAt = Date.now();

      if (interactionMode === "direct" && event.touches.length === 1) {
        const pt = toCanvasNorm(t0.clientX, t0.clientY);
        cursorX = pt.x;
        cursorY = pt.y;
        activeClient?.sendInput({
          type: "mouse_button",
          button: "left",
          action: "down",
          x: cursorX,
          y: cursorY,
        });
        dragging = true;
      } else if (interactionMode === "touchpad" && event.touches.length === 1) {
        longPressTimer = setTimeout(() => {
          if (!moved && canControl()) {
            dragging = true;
            activeClient?.sendInput({
              type: "mouse_button",
              button: "left",
              action: "down",
              x: cursorX,
              y: cursorY,
            });
          }
        }, 380);
      }
    },
    { passive: false },
  );

  stage.addEventListener(
    "touchmove",
    (event) => {
      if (!canControl()) return;
      event.preventDefault();
      const t0 = event.touches[0];
      if (!t0) return;

      const dx = t0.clientX - lastTouchX;
      const dy = t0.clientY - lastTouchY;
      lastTouchX = t0.clientX;
      lastTouchY = t0.clientY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        moved = true;
        clearLongPress();
      }

      const now = performance.now();
      if (now - lastMoveEmitAt < 16) return;
      lastMoveEmitAt = now;

      if (event.touches.length >= 2) {
        // Two-finger drag -> smooth scroll wheel
        activeClient?.sendInput({
          type: "mouse_scroll",
          deltaX: -dx * 2,
          deltaY: -dy * 2,
          x: cursorX,
          y: cursorY,
        });
        return;
      }

      if (interactionMode === "direct") {
        const pt = toCanvasNorm(t0.clientX, t0.clientY);
        cursorX = pt.x;
        cursorY = pt.y;
        activeClient?.sendInput({ type: "mouse_move", x: cursorX, y: cursorY });
        return;
      }

      const rect = stage.getBoundingClientRect();
      const speed = 1.65;
      cursorX = Math.max(0, Math.min(1, cursorX + (dx * speed) / Math.max(1, rect.width)));
      cursorY = Math.max(0, Math.min(1, cursorY + (dy * speed) / Math.max(1, rect.height)));
      updateCursorDot();
      activeClient?.sendInput({ type: "mouse_move", x: cursorX, y: cursorY });
    },
    { passive: false },
  );

  stage.addEventListener(
    "touchend",
    (event) => {
      clearLongPress();
      if (!canControl()) return;
      event.preventDefault();

      if (event.touches.length > 0) return;

      if (dragging) {
        dragging = false;
        activeClient?.sendInput({
          type: "mouse_button",
          button: "left",
          action: "up",
          x: cursorX,
          y: cursorY,
        });
        maxFingers = 0;
        return;
      }

      const duration = Date.now() - touchStartAt;
      if (!moved && duration < 280) {
        if (maxFingers >= 2) {
          // Two-finger tap -> right click
          sendVirtualClick("right", "click");
        } else {
          const now = Date.now();
          const isDouble = now - lastTapAt < 300;
          lastTapAt = now;
          sendVirtualClick("left", isDouble ? "double_click" : "click");
        }
      }
      maxFingers = 0;
    },
    { passive: false },
  );
}

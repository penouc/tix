import type {
  RemoteDesktopClientStats,
  RemoteDesktopClientStatus,
  RemoteDesktopSessionInfo,
} from "@t3tools/client-runtime/remote-desktop/client";

export interface MobileRemoteDesktopConfiguration {
  readonly directOrigin?: string | null;
  readonly directWsPath?: string | null;
  readonly directTicket?: string | null;
  readonly relayUrl?: string | null;
  readonly relayAccessToken?: string | null;
  readonly masterKey: string;
  readonly initialAllowControl: boolean;
}

export type MobileRemoteDesktopBridgeMessage =
  | {
      readonly type: "status";
      readonly status: RemoteDesktopClientStatus;
      readonly detail?: string;
    }
  | { readonly type: "session_info"; readonly info: RemoteDesktopSessionInfo }
  | { readonly type: "stats"; readonly stats: RemoteDesktopClientStats }
  | { readonly type: "capture_error"; readonly message: string };

export function remoteDesktopStreamDocument(
  configuration: MobileRemoteDesktopConfiguration,
  script: string,
): string {
  const safeConfig = JSON.stringify(configuration).replace(/</g, "\\u003c");
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const failure =
    'window.ReactNativeWebView.postMessage(JSON.stringify({type:"status",status:"error",detail:"Remote desktop viewer crashed unexpectedly."}));';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head><body><script>window.addEventListener("error",function(){${failure}});window.addEventListener("unhandledrejection",function(){${failure}});\n${safeScript}\ntry{T3RemoteDesktopStream.start(${safeConfig});}catch{${failure}}</script></body></html>`;
}

export function parseRemoteDesktopBridgeMessage(
  raw: string,
): MobileRemoteDesktopBridgeMessage | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MobileRemoteDesktopBridgeMessage>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    if (
      parsed.type === "status" ||
      parsed.type === "session_info" ||
      parsed.type === "stats" ||
      parsed.type === "capture_error"
    ) {
      return parsed as MobileRemoteDesktopBridgeMessage;
    }
  } catch {
    // Ignore malformed messages.
  }
  return null;
}

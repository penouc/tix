import type { StaticScreenProps } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";
import type {
  RemoteDesktopClientStats,
  RemoteDesktopClientStatus,
  RemoteDesktopSessionInfo,
} from "@t3tools/client-runtime/remote-desktop/client";
import type { RemoteDesktopQualityPreset } from "@t3tools/contracts";
import remoteDesktopStreamScript from "@t3tools/mobile-remotedesktop-stream";
import { T, useGT } from "gt-react-native";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import {
  type MobileRemoteDesktopConfiguration,
  parseRemoteDesktopBridgeMessage,
  remoteDesktopStreamDocument,
} from "./remote-desktop-document";

export type RemoteDesktopRouteParams = {
  readonly title: string;
  readonly directOrigin?: string;
  readonly directWsPath?: string;
  readonly directTicket?: string;
  readonly relayUrl?: string;
  readonly relayAccessToken?: string;
  readonly masterKey: string;
  readonly initialAllowControl: boolean;
  readonly initialFingerprint?: string;
};

type RemoteDesktopRouteScreenProps = StaticScreenProps<RemoteDesktopRouteParams>;

const MOBILE_SHORTCUTS: ReadonlyArray<{
  readonly label: string;
  readonly key: string;
  readonly modifiers?: ReadonlyArray<"ctrl" | "alt" | "shift" | "meta">;
}> = [
  { label: "Esc", key: "escape" },
  { label: "Tab", key: "tab" },
  { label: "Cmd+C", key: "c", modifiers: ["meta"] },
  { label: "Cmd+V", key: "v", modifiers: ["meta"] },
  { label: "Cmd+Z", key: "z", modifiers: ["meta"] },
  { label: "Ctrl+C", key: "c", modifiers: ["ctrl"] },
  { label: "Enter", key: "enter" },
  { label: "⌫", key: "backspace" },
];

const QUALITY_CYCLE: ReadonlyArray<RemoteDesktopQualityPreset> = ["smooth", "auto", "hd", "ultra"];

export function RemoteDesktopRouteScreen({ route }: RemoteDesktopRouteScreenProps) {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView | null>(null);

  const [status, setStatus] = useState<RemoteDesktopClientStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<RemoteDesktopSessionInfo | null>(null);
  const [stats, setStats] = useState<RemoteDesktopClientStats>({
    fps: 0,
    rttMs: null,
    bitrateKbps: 0,
    codec: "h264",
    transport: route.params.directOrigin && route.params.directTicket ? "direct" : "relay",
    encrypted: false,
    width: 1920,
    height: 1080,
  });

  const [collapsed, setCollapsed] = useState(false);
  const [viewOnly, setViewOnly] = useState(!route.params.initialAllowControl);
  const [mode, setMode] = useState<"touchpad" | "direct">("touchpad");
  const [trayOpen, setTrayOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");

  const configuration: MobileRemoteDesktopConfiguration = useMemo(
    () => ({
      directOrigin: route.params.directOrigin ?? null,
      directWsPath: route.params.directWsPath ?? null,
      directTicket: route.params.directTicket ?? null,
      relayUrl: route.params.relayUrl ?? null,
      relayAccessToken: route.params.relayAccessToken ?? null,
      masterKey: route.params.masterKey,
      initialAllowControl: route.params.initialAllowControl,
    }),
    [route.params],
  );

  const html = useMemo(
    () => remoteDesktopStreamDocument(configuration, remoteDesktopStreamScript),
    [configuration],
  );

  const inject = (code: string) => {
    webViewRef.current?.injectJavaScript(`${code};true;`);
  };

  const canControl = !viewOnly && (sessionInfo?.allowControl ?? route.params.initialAllowControl);
  const fingerprint = sessionInfo?.fingerprint ?? route.params.initialFingerprint ?? null;
  const e2eeBadgeText = fingerprint && !collapsed ? `E2EE · ${fingerprint.slice(0, 9)}` : "E2EE";
  const activeQuality = sessionInfo?.quality ?? "hd";
  const transportLabel = stats.transport === "relay" ? gt("Relay") : gt("Direct");
  const codecLabel = stats.codec === "h264" ? "H.264" : "JPEG";
  const bitrateLabel =
    stats.bitrateKbps >= 1000
      ? `${(stats.bitrateKbps / 1000).toFixed(1)}M`
      : `${stats.bitrateKbps}k`;
  const hudStatsText =
    status === "streaming"
      ? `${transportLabel} · ${codecLabel} · ${stats.fps}fps · ${bitrateLabel}${stats.rttMs !== null ? ` · ${stats.rttMs}ms` : ""}`
      : transportLabel;

  const toggleViewOnly = () => {
    if (sessionInfo && !sessionInfo.allowControl) return;
    const next = !viewOnly;
    setViewOnly(next);
    inject(`T3RemoteDesktopStream.setViewOnly(${JSON.stringify(next)})`);
  };

  const toggleMode = () => {
    const next = mode === "touchpad" ? "direct" : "touchpad";
    setMode(next);
    inject(`T3RemoteDesktopStream.setInteractionMode(${JSON.stringify(next)})`);
  };

  const cycleQuality = () => {
    const idx = QUALITY_CYCLE.indexOf(activeQuality);
    const next = QUALITY_CYCLE[(idx + 1) % QUALITY_CYCLE.length] ?? "hd";
    inject(`T3RemoteDesktopStream.setQuality(${JSON.stringify(next)})`);
  };

  const cycleDisplay = () => {
    const displays = sessionInfo?.displays ?? [];
    if (displays.length <= 1) return;
    const currentIdx = displays.findIndex((d) => d.id === sessionInfo?.activeDisplayId);
    const next = displays[(currentIdx + 1) % displays.length];
    if (next) {
      inject(`T3RemoteDesktopStream.setDisplay(${JSON.stringify(next.id)})`);
    }
  };

  const sendText = () => {
    if (!textDraft || !canControl) return;
    inject(`T3RemoteDesktopStream.sendInput(${JSON.stringify({ type: "text", text: textDraft })})`);
    setTextDraft("");
  };

  return (
    <View className="flex-1 bg-black">
      <WebView<object>
        ref={webViewRef}
        originWhitelist={["*"]}
        source={{ html, baseUrl: "https://localhost/" }}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        scrollEnabled={false}
        bounces={false}
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        style={{ flex: 1, backgroundColor: "#000" }}
        onMessage={(event) => {
          const msg = parseRemoteDesktopBridgeMessage(event.nativeEvent.data);
          if (!msg) return;
          if (msg.type === "status") {
            setStatus(msg.status);
            if (msg.detail) setStatusDetail(msg.detail);
          } else if (msg.type === "session_info") {
            setSessionInfo(msg.info);
            setCaptureError(null);
            if (!msg.info.allowControl) setViewOnly(true);
          } else if (msg.type === "stats") {
            setStats(msg.stats);
          } else if (msg.type === "capture_error") {
            setCaptureError(msg.message);
          }
        }}
      />

      {/* UU-style Floating Top HUD Pill */}
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          top: Math.max(insets.top, 8) + 4,
          left: 10,
          right: 10,
          alignItems: "center",
        }}
      >
        <View className="flex-row flex-wrap items-center justify-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5">
          <Text className="text-xs font-semibold text-foreground" numberOfLines={1}>
            {route.params.title}
          </Text>

          <View className="rounded-full bg-success/15 px-2 py-0.5">
            <Text className="text-2xs font-medium text-success">{e2eeBadgeText}</Text>
          </View>

          <View className="rounded-full bg-muted px-2 py-0.5">
            <Text className="text-2xs text-muted-foreground">{hudStatsText}</Text>
          </View>

          {!collapsed ? (
            <>
              <Pressable
                onPress={toggleViewOnly}
                className={`rounded-full px-2.5 py-1 ${
                  canControl ? "bg-info/20" : "bg-warning/20"
                }`}
              >
                <Text className="text-2xs font-medium text-foreground">
                  {canControl ? gt("Control") : gt("View only")}
                </Text>
              </Pressable>

              {canControl ? (
                <Pressable onPress={toggleMode} className="rounded-full bg-muted px-2.5 py-1">
                  <Text className="text-2xs text-foreground">
                    {mode === "touchpad" ? gt("Touchpad") : gt("Direct")}
                  </Text>
                </Pressable>
              ) : null}

              <Pressable onPress={cycleQuality} className="rounded-full bg-muted px-2.5 py-1">
                <Text className="text-2xs text-foreground">{activeQuality.toUpperCase()}</Text>
              </Pressable>

              {(sessionInfo?.displays.length ?? 0) > 1 ? (
                <Pressable onPress={cycleDisplay} className="rounded-full bg-muted px-2.5 py-1">
                  <Text className="text-2xs text-foreground">
                    <T>Display</T>
                  </Text>
                </Pressable>
              ) : null}

              {canControl ? (
                <Pressable
                  onPress={() => setTrayOpen((prev) => !prev)}
                  className={`rounded-full px-2.5 py-1 ${trayOpen ? "bg-primary" : "bg-muted"}`}
                >
                  <Text
                    className={`text-2xs ${trayOpen ? "text-primary-foreground" : "text-foreground"}`}
                  >
                    <T>Keys</T>
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}

          <Pressable
            onPress={() => setCollapsed((prev) => !prev)}
            className="rounded-full bg-muted px-2 py-1"
          >
            <Text className="text-2xs text-muted-foreground">
              {collapsed ? gt("Expand") : gt("Hide")}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              inject("T3RemoteDesktopStream.stop()");
              navigation.goBack();
            }}
            className="rounded-full bg-destructive/20 px-2.5 py-1"
          >
            <Text className="text-2xs font-medium text-destructive">
              <T>Close</T>
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Connecting / Error Overlay */}
      {status !== "streaming" || captureError ? (
        <View
          pointerEvents="box-none"
          className="absolute inset-0 items-center justify-center bg-background/75 px-6"
        >
          <View className="w-full max-w-sm items-center gap-3 rounded-2xl border border-border bg-card p-5">
            {status !== "error" && !captureError ? <AppActivityIndicator /> : null}
            <Text className="text-center text-sm font-semibold text-foreground">
              {captureError ? (
                <T>Screen capture permission required on host</T>
              ) : status === "waiting_host" ? (
                <T>Waiting for host computer</T>
              ) : status === "error" ? (
                <T>Connection failed</T>
              ) : (
                <T>Establishing end-to-end encrypted channel...</T>
              )}
            </Text>
            <Text className="text-center text-xs text-muted-foreground">
              {captureError ??
                (statusDetail || gt("Negotiating X25519 + AES-256-GCM encrypted tunnel..."))}
            </Text>
            <View className="flex-row gap-2 pt-1">
              <Pressable
                onPress={() => inject("T3RemoteDesktopStream.reconnect()")}
                className="rounded-lg bg-secondary px-4 py-2"
              >
                <Text className="text-xs font-medium text-secondary-foreground">
                  <T>Retry</T>
                </Text>
              </Pressable>
              <Pressable
                onPress={() => navigation.goBack()}
                className="rounded-lg bg-destructive/15 px-4 py-2"
              >
                <Text className="text-xs font-medium text-destructive">
                  <T>Back</T>
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/* UU-style Bottom Virtual Mouse & Keyboard Bar */}
      {trayOpen && canControl ? (
        <View
          style={{
            paddingBottom: Math.max(insets.bottom, 10),
          }}
          className="border-t border-border bg-card px-3 pt-2.5"
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
            <View className="flex-row items-center gap-1.5">
              <Pressable
                onPress={() => inject('T3RemoteDesktopStream.sendVirtualClick("left","click")')}
                className="rounded-lg bg-secondary px-3 py-1.5"
              >
                <Text className="text-xs font-medium text-secondary-foreground">
                  <T>Left</T>
                </Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  inject('T3RemoteDesktopStream.sendVirtualClick("left","double_click")')
                }
                className="rounded-lg bg-secondary px-3 py-1.5"
              >
                <Text className="text-xs font-medium text-secondary-foreground">
                  <T>Double</T>
                </Text>
              </Pressable>
              <Pressable
                onPress={() => inject('T3RemoteDesktopStream.sendVirtualClick("right","click")')}
                className="rounded-lg bg-secondary px-3 py-1.5"
              >
                <Text className="text-xs font-medium text-secondary-foreground">
                  <T>Right</T>
                </Text>
              </Pressable>

              {MOBILE_SHORTCUTS.map((item) => (
                <Pressable
                  key={item.label}
                  onPress={() =>
                    inject(
                      `T3RemoteDesktopStream.sendInput(${JSON.stringify({
                        type: "key",
                        action: "press",
                        key: item.key,
                        ...(item.modifiers ? { modifiers: item.modifiers } : {}),
                      })})`,
                    )
                  }
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5"
                >
                  <Text className="text-xs text-foreground">{item.label}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          <View className="flex-row items-center gap-2">
            <TextInput
              value={textDraft}
              onChangeText={setTextDraft}
              onSubmitEditing={sendText}
              placeholder={gt("Type text to send to the remote computer...")}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
              returnKeyType="send"
            />
            <Pressable onPress={sendText} className="rounded-lg bg-primary px-3.5 py-2">
              <Text className="text-xs font-semibold text-primary-foreground">
                <T>Send</T>
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

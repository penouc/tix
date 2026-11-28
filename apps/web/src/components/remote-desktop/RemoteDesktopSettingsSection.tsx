import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RemoteDesktopProbeRelayResult,
  RemoteDesktopQualityPreset,
} from "@t3tools/contracts";
import { decodeRemoteDesktopPairingUri } from "@t3tools/shared/remoteDesktopCrypto";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react";
import {
  CheckCircle2Icon,
  CopyIcon,
  KeyRoundIcon,
  Link2Icon,
  MonitorIcon,
  RadioIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironments } from "../../state/environments";
import {
  openRemoteDesktopModal,
  remoteDesktopEnvironment,
  useRemoteDesktopStatus,
} from "../../state/remoteDesktop";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

function EnvironmentRemoteDesktopCard(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const gt = useGT();
  const { status, loaded, refresh } = useRemoteDesktopStatus(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const issueTicket = useAtomCommand(remoteDesktopEnvironment.issueTicket);
  const rotateKey = useAtomCommand(remoteDesktopEnvironment.rotateKey);
  const disconnectViewer = useAtomCommand(remoteDesktopEnvironment.disconnectViewer);
  const probeRelay = useAtomCommand(remoteDesktopEnvironment.probeRelay);

  const prepared = useAtomValue(
    environmentSession.preparedConnectionValueAtom(props.environmentId),
  );
  const directOrigin = Option.getOrNull(prepared)?.httpBaseUrl ?? null;

  const [relayUrlDraft, setRelayUrlDraft] = useState<string | null>(null);
  const [relayTokenDraft, setRelayTokenDraft] = useState("");
  const [probeResult, setProbeResult] = useState<RemoteDesktopProbeRelayResult | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveRelayUrl = relayUrlDraft ?? status?.relayUrl ?? "";

  const handleToggleEnabled = (enabled: boolean) => {
    setBusy(true);
    updateSettings(
      { remoteDesktop: { enabled } },
      {
        onSaved: () => {
          setBusy(false);
          refresh();
        },
        onFailed: () => setBusy(false),
      },
    );
  };

  const handleToggleControl = (allowControl: boolean) => {
    setBusy(true);
    updateSettings(
      { remoteDesktop: { allowControl } },
      {
        onSaved: () => {
          setBusy(false);
          refresh();
        },
        onFailed: () => setBusy(false),
      },
    );
  };

  const handleSaveRelay = () => {
    setBusy(true);
    updateSettings(
      {
        remoteDesktop: {
          relayUrl: effectiveRelayUrl.trim(),
          ...(relayTokenDraft.trim() ? { relayAccessToken: relayTokenDraft.trim() } : {}),
        },
      },
      {
        onSaved: () => {
          setBusy(false);
          setRelayUrlDraft(null);
          setRelayTokenDraft("");
          refresh();
          toastManager.add({
            title: gt("Cloudflare relay settings saved"),
            type: "success",
          });
        },
        onFailed: () => setBusy(false),
      },
    );
  };

  const handleProbeRelay = async () => {
    const target = effectiveRelayUrl.trim();
    if (!target) return;
    setBusy(true);
    try {
      const result = await probeRelay({
        environmentId: props.environmentId,
        input: {
          relayUrl: target,
          ...(relayTokenDraft.trim() ? { relayAccessToken: relayTokenDraft.trim() } : {}),
        },
      });
      if (AsyncResult.isSuccess(result)) {
        setProbeResult(result.value);
      } else {
        const failure = squashAtomCommandFailure(result);
        setProbeResult({
          ok: false,
          relayUrl: target,
          protocolVersion: null,
          authRequired: false,
          latencyMs: null,
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleOpenScreen = async () => {
    setBusy(true);
    try {
      const result = await issueTicket({
        environmentId: props.environmentId,
        input: {},
      });
      if (!AsyncResult.isSuccess(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          title: gt("Failed to open remote desktop"),
          description: failure instanceof Error ? failure.message : String(failure),
          type: "error",
        });
        return;
      }
      const ticket = result.value;
      const currentPrepared = Option.getOrNull(
        appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(props.environmentId)),
      );
      openRemoteDesktopModal({
        kind: "environment",
        environmentId: props.environmentId,
        environmentLabel: props.label,
        directOrigin: currentPrepared?.httpBaseUrl ?? directOrigin,
        ticket,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCopyPairingUri = async () => {
    setBusy(true);
    try {
      const result = await issueTicket({
        environmentId: props.environmentId,
        input: {},
      });
      if (!AsyncResult.isSuccess(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          title: gt("Could not copy pairing code"),
          description: failure instanceof Error ? failure.message : String(failure),
          type: "error",
        });
        return;
      }
      const ticket = result.value;
      if (!ticket.pairingUri) {
        toastManager.add({
          title: gt("Configure a Cloudflare relay domain first"),
          description: gt("A relay URL is required to generate an E2EE pairing code."),
          type: "warning",
        });
        return;
      }
      await navigator.clipboard.writeText(ticket.pairingUri);
      toastManager.add({
        title: gt("E2EE relay pairing code copied"),
        description: gt(
          "The 256-bit key stays in the URL fragment and is never sent to Cloudflare.",
        ),
        type: "success",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRotateKey = async () => {
    setBusy(true);
    try {
      const result = await rotateKey({ environmentId: props.environmentId, input: {} });
      if (!AsyncResult.isSuccess(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          title: gt("Failed to rotate encryption key"),
          description: failure instanceof Error ? failure.message : String(failure),
          type: "error",
        });
        return;
      }
      refresh();
      toastManager.add({
        title: gt("E2EE master key rotated"),
        description: gt(
          "Previous viewers were disconnected and a new zero-knowledge relay room is active.",
        ),
        type: "success",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleQualityChange = (quality: RemoteDesktopQualityPreset) => {
    updateSettings({ remoteDesktop: { defaultQuality: quality } }, { onSaved: () => refresh() });
  };

  const relayStatusBadge =
    status?.relayState === "connected"
      ? "bg-success/15 text-success"
      : status?.relayState === "connecting" || status?.relayState === "reconnecting"
        ? "bg-warning/15 text-warning"
        : "bg-muted text-muted-foreground";

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-card/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MonitorIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">{props.label}</span>
          {status?.enabled ? (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${relayStatusBadge}`}
            >
              <RadioIcon className="size-3" />
              {status.relayUrl
                ? gt("CF Relay: {state}", { state: status.relayState })
                : gt("Direct LAN / Tailscale")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {status?.enabled ? (
            <Button size="xs" onClick={() => void handleOpenScreen()} disabled={busy}>
              <MonitorIcon className="size-3.5" />
              <T>Open remote desktop</T>
            </Button>
          ) : null}
          <Switch
            checked={status?.enabled ?? false}
            disabled={!loaded || busy}
            onCheckedChange={(checked) => handleToggleEnabled(checked)}
            aria-label={gt("Enable remote desktop on {label}", { label: props.label })}
          />
        </div>
      </div>

      {status?.enabled ? (
        <div className="space-y-3 border-t border-border/50 pt-3">
          <SettingsRow
            title={gt("Allow remote control")}
            description={gt(
              "When off, all viewers are locked to view-only mode and cannot send mouse or keyboard input.",
            )}
          >
            <Switch
              checked={status.allowControl}
              disabled={busy}
              onCheckedChange={(checked) => handleToggleControl(checked)}
            />
          </SettingsRow>

          <SettingsRow
            title={gt("Default stream quality")}
            description={gt("Capture: {capture} · Input: {input} · Displays: {count}", {
              capture: status.captureBackend,
              input: status.inputBackend,
              count: status.displays.length,
            })}
          >
            <select
              aria-label={gt("Default stream quality")}
              defaultValue="hd"
              onChange={(e) => handleQualityChange(e.target.value as RemoteDesktopQualityPreset)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              <option value="smooth">{gt("Smooth (low bandwidth)")}</option>
              <option value="auto">{gt("Auto")}</option>
              <option value="hd">{gt("HD (recommended)")}</option>
              <option value="ultra">{gt("Ultra")}</option>
            </select>
          </SettingsRow>

          <div className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                <T>Cloudflare custom relay domain (Zero-Knowledge E2EE)</T>
              </span>
              {status.fingerprint ? (
                <span className="inline-flex items-center gap-1 font-mono text-2xs text-success">
                  <ShieldCheckIcon className="size-3" />
                  <span>{status.fingerprint}</span>
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              <T>
                Enter your Cloudflare Workers relay domain (for example https://relay.penglei.dev).
                The relay forwards opaque X25519 + AES-256-GCM ciphertext frames and can never
                decrypt your screen or input.
              </T>
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={effectiveRelayUrl}
                onChange={(e) => setRelayUrlDraft(e.target.value)}
                placeholder="https://relay.penglei.dev"
                className="flex-1"
              />
              <Input
                type="password"
                value={relayTokenDraft}
                onChange={(e) => setRelayTokenDraft(e.target.value)}
                placeholder={gt("Relay access token (optional)")}
                className="sm:w-48"
              />
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void handleProbeRelay()}
                  disabled={busy || !effectiveRelayUrl.trim()}
                >
                  <T>Test relay</T>
                </Button>
                <Button size="xs" onClick={handleSaveRelay} disabled={busy}>
                  <T>Save</T>
                </Button>
              </div>
            </div>

            {probeResult ? (
              <div
                className={`flex items-center gap-1.5 text-xs ${
                  probeResult.ok ? "text-success" : "text-destructive"
                }`}
              >
                <CheckCircle2Icon className="size-3.5 shrink-0" />
                <span>
                  {probeResult.ok
                    ? gt("Relay reachable ({url}) · {ms}ms · protocol v{version}", {
                        url: probeResult.relayUrl,
                        ms: probeResult.latencyMs ?? 0,
                        version: probeResult.protocolVersion ?? 1,
                      })
                    : (probeResult.error ?? gt("Relay unreachable"))}
                </span>
              </div>
            ) : null}

            {status.relayError ? (
              <div className="text-xs text-warning">{status.relayError}</div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="xs"
                variant="outline"
                onClick={() => void handleCopyPairingUri()}
                disabled={busy || !status.relayUrl}
              >
                <CopyIcon className="size-3" />
                <T>Copy E2EE pairing code</T>
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void handleRotateKey()}
                disabled={busy}
              >
                <KeyRoundIcon className="size-3" />
                <T>Rotate encryption key</T>
              </Button>
              <Button size="xs" variant="ghost" onClick={refresh} disabled={busy}>
                <RefreshCwIcon className="size-3" />
                <T>Refresh</T>
              </Button>
            </div>
          </div>

          {status.activeViewers.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {gt("Active viewers ({count})", { count: status.activeViewers.length })}
              </div>
              {status.activeViewers.map((viewer) => (
                <div
                  key={viewer.peerId}
                  className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{viewer.label}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs">
                      {viewer.transport}
                    </span>
                    <span className="text-muted-foreground">
                      {viewer.controlAllowed ? gt("Control enabled") : gt("View only")}
                    </span>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void disconnectViewer({
                        environmentId: props.environmentId,
                        input: { peerId: viewer.peerId },
                      })
                    }
                  >
                    <UnplugIcon className="size-3" />
                    <T>Disconnect</T>
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function RemoteDesktopSettingsSection() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const connectedEnvironments = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const [pairingUriInput, setPairingUriInput] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);

  const handleConnectPairingUri = () => {
    setPairingError(null);
    try {
      const parsed = decodeRemoteDesktopPairingUri(pairingUriInput);
      openRemoteDesktopModal({
        kind: "pairing",
        label: parsed.label ?? gt("Remote Desktop"),
        relayUrl: parsed.relayUrl,
        masterKey: parsed.masterKey,
        ...(parsed.relayAccessToken ? { relayAccessToken: parsed.relayAccessToken } : {}),
      });
      setPairingUriInput("");
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : gt("Invalid E2EE pairing code"));
    }
  };

  return (
    <SettingsSection title={gt("Remote Desktop & Cloudflare Relay")}>
      <p className="mb-3 text-xs text-muted-foreground">
        <T>
          End-to-end encrypted desktop screen casting and remote control. Connects directly over LAN
          or Tailscale when available, and falls back to your custom Cloudflare Workers relay domain
          remotely.
        </T>
      </p>
      <div className="space-y-3">
        {connectedEnvironments.map((environment) => (
          <EnvironmentRemoteDesktopCard
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))}

        <div className="space-y-2 rounded-xl border border-dashed border-border/80 bg-card/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Link2Icon className="size-4 text-muted-foreground" />
            <T>Connect via E2EE relay pairing code</T>
          </div>
          <p className="text-xs text-muted-foreground">
            <T>
              Paste a tixrd:// pairing code from another computer to start an encrypted remote
              desktop session directly through your Cloudflare relay.
            </T>
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={pairingUriInput}
              onChange={(e) => setPairingUriInput(e.target.value)}
              placeholder="tixrd://v1?relay=https%3A%2F%2Frelay.penglei.dev#k=..."
              className="flex-1"
            />
            <Button size="xs" onClick={handleConnectPairingUri} disabled={!pairingUriInput.trim()}>
              <MonitorIcon className="size-3.5" />
              <T>Connect</T>
            </Button>
          </div>
          {pairingError ? <p className="text-xs text-destructive">{pairingError}</p> : null}
        </div>
      </div>
    </SettingsSection>
  );
}

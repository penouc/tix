import { useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { decodeRemoteDesktopPairingUri } from "@t3tools/shared/remoteDesktopCrypto";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironmentQuery } from "../../state/query";
import { remoteDesktopEnvironment } from "../../state/remoteDesktop";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

function MobileRemoteDesktopRow(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const statusQuery = useEnvironmentQuery(
    remoteDesktopEnvironment.status({ environmentId: props.environmentId, input: {} }),
  );
  const prepared = usePreparedConnection(props.environmentId);
  const issueTicket = useAtomCommand(remoteDesktopEnvironment.issueTicket);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = statusQuery.data;
  const directOrigin = Option.getOrNull(prepared)?.httpBaseUrl ?? undefined;

  const handleOpen = async () => {
    setError(null);
    setOpening(true);
    try {
      const result = await issueTicket({ environmentId: props.environmentId, input: {} });
      if (!AsyncResult.isSuccess(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : String(failure));
        return;
      }
      const ticket = result.value;
      navigation.navigate("RemoteDesktop", {
        title: props.environmentLabel,
        ...(directOrigin ? { directOrigin } : {}),
        directWsPath: ticket.directWsPath,
        directTicket: ticket.directTicket,
        ...(ticket.relayUrl ? { relayUrl: ticket.relayUrl } : {}),
        ...(ticket.relayAccessToken ? { relayAccessToken: ticket.relayAccessToken } : {}),
        masterKey: ticket.masterKey,
        initialAllowControl: ticket.allowControl,
        initialFingerprint: ticket.fingerprint,
      });
    } finally {
      setOpening(false);
    }
  };

  return (
    <View className="gap-2 border-b border-border/50 p-4 last:border-b-0">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-t3-bold text-foreground">{props.environmentLabel}</Text>
          <Text className="text-xs text-muted-foreground">
            {status?.enabled
              ? status.relayUrl
                ? gt("E2EE · CF Relay ({state})", { state: status.relayState })
                : gt("E2EE · Direct LAN / Tailscale")
              : gt("Disabled on host (enable in Desktop Settings → Environments)")}
          </Text>
        </View>
        <Button
          label={opening ? gt("Connecting...") : gt("View desktop")}
          disabled={!status?.enabled || opening}
          onPress={() => void handleOpen()}
        />
      </View>
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}

export function RemoteDesktopEnvironmentsSection(props: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly connectionState: string;
  }>;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const [pairingUri, setPairingUri] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);

  const connected = props.environments.filter((env) => env.connectionState === "connected");

  const handleConnectPairingUri = () => {
    setPairingError(null);
    try {
      const parsed = decodeRemoteDesktopPairingUri(pairingUri);
      navigation.navigate("RemoteDesktop", {
        title: parsed.label ?? gt("Remote Desktop"),
        relayUrl: parsed.relayUrl,
        ...(parsed.relayAccessToken ? { relayAccessToken: parsed.relayAccessToken } : {}),
        masterKey: parsed.masterKey,
        initialAllowControl: true,
      });
      setPairingUri("");
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : gt("Invalid E2EE pairing code"));
    }
  };

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={gt("Remote Desktop (E2EE)")}>
        {connected.map((environment) => (
          <MobileRemoteDesktopRow
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.environmentLabel}
          />
        ))}
        <View className="gap-2 p-4">
          <Text className="text-sm font-t3-bold text-foreground">
            <T>Connect via Cloudflare E2EE pairing code</T>
          </Text>
          <Text className="text-xs text-muted-foreground">
            <T>
              Paste a tixrd:// pairing code copied from your computer to stream through your custom
              Cloudflare relay without LAN or Tailscale.
            </T>
          </Text>
          <View className="flex-row items-center gap-2">
            <TextInput
              value={pairingUri}
              onChangeText={setPairingUri}
              placeholder="tixrd://v1?relay=..."
              autoCapitalize="none"
              autoCorrect={false}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
            />
            <Pressable
              onPress={handleConnectPairingUri}
              disabled={!pairingUri.trim()}
              className="rounded-lg bg-primary px-3.5 py-2"
            >
              <Text className="text-xs font-semibold text-primary-foreground">
                <T>Connect</T>
              </Text>
            </Pressable>
          </View>
          {pairingError ? <Text className="text-xs text-destructive">{pairingError}</Text> : null}
        </View>
      </SettingsSection>
    </View>
  );
}

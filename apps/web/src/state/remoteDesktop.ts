import { useAtomValue } from "@effect/atom-react";
import { createRemoteDesktopEnvironmentAtoms } from "@t3tools/client-runtime/state/remote-desktop";
import type {
  EnvironmentId,
  RemoteDesktopConnectTicket,
  RemoteDesktopStatus,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";

export const remoteDesktopEnvironment = createRemoteDesktopEnvironmentAtoms(connectionAtomRuntime);

export type RemoteDesktopModalTarget =
  | {
      readonly kind: "environment";
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
      readonly directOrigin: string | null;
      readonly ticket: RemoteDesktopConnectTicket;
    }
  | {
      readonly kind: "pairing";
      readonly label: string;
      readonly relayUrl: string;
      readonly masterKey: string;
      readonly relayAccessToken?: string;
    };

const remoteDesktopModalTargetAtom = Atom.make<RemoteDesktopModalTarget | null>(null).pipe(
  Atom.withLabel("remote-desktop:modal-target"),
);

export function openRemoteDesktopModal(target: RemoteDesktopModalTarget): void {
  appAtomRegistry.set(remoteDesktopModalTargetAtom, target);
}

export function closeRemoteDesktopModal(): void {
  appAtomRegistry.set(remoteDesktopModalTargetAtom, null);
}

export function useRemoteDesktopModalTarget(): RemoteDesktopModalTarget | null {
  return useAtomValue(remoteDesktopModalTargetAtom);
}

export function useRemoteDesktopStatus(environmentId: EnvironmentId | null): {
  readonly status: RemoteDesktopStatus | null;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId === null ? null : remoteDesktopEnvironment.status({ environmentId, input: {} }),
    resolve,
  );
  return {
    status: query.data ?? null,
    loaded: query.data !== null,
    error: query.error,
    refresh: query.refresh,
  };
}

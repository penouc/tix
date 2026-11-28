import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createRemoteDesktopEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:remote-desktop:status",
      tag: WS_METHODS.remoteDesktopSubscribeStatus,
    }),
    getStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-desktop:get-status",
      tag: WS_METHODS.remoteDesktopGetStatus,
    }),
    issueTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-desktop:issue-ticket",
      tag: WS_METHODS.remoteDesktopIssueTicket,
    }),
    rotateKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-desktop:rotate-key",
      tag: WS_METHODS.remoteDesktopRotateKey,
    }),
    disconnectViewer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-desktop:disconnect-viewer",
      tag: WS_METHODS.remoteDesktopDisconnectViewer,
    }),
    probeRelay: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-desktop:probe-relay",
      tag: WS_METHODS.remoteDesktopProbeRelay,
    }),
  };
}

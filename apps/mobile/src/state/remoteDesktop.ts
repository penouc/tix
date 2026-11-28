import { createRemoteDesktopEnvironmentAtoms } from "@t3tools/client-runtime/state/remote-desktop";

import { connectionAtomRuntime } from "../connection/runtime";

export const remoteDesktopEnvironment = createRemoteDesktopEnvironmentAtoms(connectionAtomRuntime);

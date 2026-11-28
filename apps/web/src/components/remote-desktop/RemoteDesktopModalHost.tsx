import { useGT } from "gt-react";

import { closeRemoteDesktopModal, useRemoteDesktopModalTarget } from "../../state/remoteDesktop";
import { RemoteDesktopViewer } from "./RemoteDesktopViewer";

export function RemoteDesktopModalHost() {
  const gt = useGT();
  const target = useRemoteDesktopModalTarget();
  if (!target) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={gt("Remote Desktop")}
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
    >
      {target.kind === "environment" ? (
        <RemoteDesktopViewer
          title={target.environmentLabel}
          directOrigin={target.directOrigin}
          directWsPath={target.ticket.directWsPath}
          directTicket={target.ticket.directTicket}
          relayUrl={target.ticket.relayUrl}
          relayAccessToken={target.ticket.relayAccessToken}
          masterKey={target.ticket.masterKey}
          initialAllowControl={target.ticket.allowControl}
          initialFingerprint={target.ticket.fingerprint}
          onClose={closeRemoteDesktopModal}
        />
      ) : (
        <RemoteDesktopViewer
          title={target.label}
          relayUrl={target.relayUrl}
          relayAccessToken={target.relayAccessToken ?? null}
          masterKey={target.masterKey}
          initialAllowControl
          onClose={closeRemoteDesktopModal}
        />
      )}
    </div>
  );
}

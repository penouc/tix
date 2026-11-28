import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { requestUrl } from "../requestUrl.ts";
import * as RemoteDesktopService from "./RemoteDesktopService.ts";

const DIRECT_WS_PATH = "/api/remote-desktop/ws";
const PEER_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;

const handleDirectWebSocket = Effect.fn("RemoteDesktopHttp.handleDirectWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Expected WebSocket upgrade", { status: 426 });
  }

  const url = requestUrl(request);
  const ticket = url.searchParams.get("ticket")?.trim() ?? "";
  const peerId = url.searchParams.get("peerId")?.trim() ?? "";

  if (!ticket || !PEER_ID_PATTERN.test(peerId)) {
    return HttpServerResponse.text("Missing or invalid remote desktop ticket or peerId", {
      status: 400,
    });
  }

  const service = yield* RemoteDesktopService.RemoteDesktopService;
  const grant = yield* service.consumeDirectTicket(ticket);
  if (Option.isNone(grant)) {
    return HttpServerResponse.text("Invalid or expired remote desktop ticket", { status: 401 });
  }

  const socket = yield* request.upgrade;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const write = yield* socket.writer;
      const bridge = service.attachDirectViewer({
        peerId,
        label: grant.value.label,
        allowControl: grant.value.allowControl,
        socket: {
          sendBinary: (bytes) => {
            Effect.runFork(write(bytes).pipe(Effect.ignore));
          },
          close: () => {
            // Closing is driven by interrupting the socket scope on disconnect.
          },
        },
      });

      yield* socket
        .run((data) =>
          Effect.sync(() => {
            if (typeof data !== "string") {
              bridge.onBinaryMessage(data);
            }
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              bridge.onClose();
            }),
          ),
          Effect.ignore,
        );
    }),
  );

  return HttpServerResponse.empty({ status: 101 });
});

export const layer = Layer.mergeAll(HttpRouter.add("GET", DIRECT_WS_PATH, handleDirectWebSocket));

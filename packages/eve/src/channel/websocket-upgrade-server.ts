import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import type {
  WebSocketRouteHandler,
  WebSocketRouteHooks,
  WebSocketUpgradeRequest,
  WebSocketUpgradeResult,
} from "#channel/routes.js";

type NodeUpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => unknown;

interface NodeUpgradeRuntime {
  readonly node?: {
    readonly req?: IncomingMessage;
    readonly upgrade?: {
      readonly head?: Buffer;
      readonly socket?: Duplex;
    };
  };
}

interface NodeWebSocketUpgradeRequest extends WebSocketUpgradeRequest {
  readonly runtime?: NodeUpgradeRuntime;
}

/**
 * Escape hatch for SDKs and frameworks that need a Node HTTP server-shaped
 * upgrade target inside an eve `WS()` route.
 *
 * Prefer normal `WS()` lifecycle hooks for eve-owned websocket behavior. Use
 * this bridge only when an integration expects to register
 * `httpServer.on("upgrade", ...)` handlers itself. The server is intentionally
 * not listening on a port; eve forwards only the matched route's raw Node
 * upgrade into it.
 */
export interface WebSocketUpgradeServerBridge {
  readonly route: WebSocketRouteHandler;
  readonly server: Server;
}

/**
 * Creates an escape-hatch Node HTTP server facade plus a `WS()` route handler
 * that forwards matched raw upgrade events into that server.
 *
 * Prefer authoring websocket behavior directly with `WS()` hooks. Reach for
 * this only when an SDK or framework binds to `http.Server` upgrade events,
 * such as `engine.attach(server, path, ...)`. It works only on hosts where
 * Nitro exposes a Node upgrade tuple for the matched WebSocket route.
 */
export function createWebSocketUpgradeServer(): WebSocketUpgradeServerBridge {
  const server = createServer();

  return {
    route: createWebSocketUpgradeRoute(server),
    server,
  };
}

function createWebSocketUpgradeRoute(server: Server): WebSocketRouteHandler {
  return () =>
    ({
      upgrade(request) {
        return dispatchNodeUpgrade(server, request);
      },
    }) satisfies WebSocketRouteHooks;
}

async function dispatchNodeUpgrade(
  server: Server,
  request: WebSocketUpgradeRequest,
): Promise<WebSocketUpgradeResult> {
  const upgrade = resolveNodeUpgrade(request);

  if (upgrade === null) {
    return Response.json(
      {
        error: "This WebSocket route cannot expose a Node upgrade event on the current host.",
        ok: false,
      },
      { status: 501 },
    );
  }

  const listeners = server.listeners("upgrade") as NodeUpgradeListener[];

  if (listeners.length === 0) {
    return Response.json(
      {
        error: "No upgrade listeners are registered on this WebSocket server bridge.",
        ok: false,
      },
      { status: 500 },
    );
  }

  for (const listener of listeners) {
    await Promise.resolve(listener.call(server, upgrade.request, upgrade.socket, upgrade.head));
  }

  return { handled: true };
}

function resolveNodeUpgrade(request: WebSocketUpgradeRequest): {
  head: Buffer;
  request: IncomingMessage;
  socket: Duplex;
} | null {
  const runtime = (request as NodeWebSocketUpgradeRequest).runtime;
  const node = runtime?.node;
  const nodeRequest = node?.req;
  const socket = node?.upgrade?.socket;
  const head = node?.upgrade?.head;

  if (nodeRequest === undefined || socket === undefined || head === undefined) {
    return null;
  }

  if (typeof nodeRequest.url !== "string" || nodeRequest.url.length === 0) {
    const url = new URL(request.url);
    nodeRequest.url = `${url.pathname}${url.search}`;
  }

  return {
    head,
    request: nodeRequest,
    socket,
  };
}

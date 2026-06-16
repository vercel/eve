import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

const STOP_FORCE_CLOSE_GRACE_MS = 250;
const STOP_TIMEOUT_MS = 2_000;

/**
 * Minimal in-process MCP server speaking the Streamable HTTP transport
 * subset used by `@ai-sdk/mcp`. Implements just enough to satisfy a
 * client doing `initialize` → `tools/list` → `tools/call` for one
 * tool. Notifications return 202; unknown methods return a JSON-RPC
 * "method not found" so optional discovery (`resources/list`,
 * `prompts/list`, etc.) degrades gracefully.
 *
 * The stub exposes one tool, `echo_marker`, which echoes back the
 * `marker` string supplied at construction time. Used by
 * `tui-connection-auth-user.ts` to prove the user-authenticated
 * `defineMcpClientConnection` path without depending on a remote MCP server.
 */
const PROTOCOL_VERSION = "2025-11-25";

export interface McpStubServerHandle {
  readonly url: string;
  stop(): Promise<void>;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: unknown;
}

interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly error: { code: number; message: string };
}

export async function startMcpStubServer(input: {
  marker: string;
  /**
   * When true, every HTTP request must include a non-empty
   * `Authorization: Bearer <token>` header. Unauth'd requests get a
   * `401 Unauthorized`. Used by smokes that exercise OAuth-backed MCP
   * connections; without this gate the smoke can't prove the access
   * token actually reached MCP. Defaults to false to keep the legacy
   * non-auth smoke path available.
   */
  requireBearer?: boolean;
}): Promise<McpStubServerHandle> {
  const { marker, requireBearer = false } = input;

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, { marker, requireBearer }).catch((error) => {
      respondError(res, null, -32603, error instanceof Error ? error.message : String(error));
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/mcp`;
  let stopped = false;

  return {
    url,
    async stop() {
      if (stopped) return;
      stopped = true;
      await forceCloseMcpStubServer(server, sockets);
    },
  };
}

async function forceCloseMcpStubServer(server: Server, sockets: Set<Socket>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      clearTimeout(timeoutTimer);
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    };

    const forceClose = (): void => {
      server.closeAllConnections();
      for (const socket of sockets) {
        socket.destroy();
      }
      server.unref();
    };

    const forceCloseTimer = setTimeout(forceClose, STOP_FORCE_CLOSE_GRACE_MS);
    forceCloseTimer.unref();

    const timeoutTimer = setTimeout(() => {
      forceClose();
      finish();
    }, STOP_TIMEOUT_MS);
    timeoutTimer.unref();

    server.close((err) => {
      finish(err ?? undefined);
    });
    server.closeIdleConnections();
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { readonly marker: string; readonly requireBearer: boolean },
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed");
    return;
  }

  if (ctx.requireBearer) {
    const authHeader = req.headers.authorization;
    const bearer = typeof authHeader === "string" ? authHeader.match(/^Bearer\s+(.+)$/) : null;
    if (!bearer || bearer[1]!.trim().length === 0) {
      res
        .writeHead(401, { "content-type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: "missing_or_invalid_bearer_token" }));
      return;
    }
  }

  const body = await readJsonBody(req);
  if (body === null) {
    respondError(res, null, -32700, "Parse error");
    return;
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses: (JsonRpcSuccess | JsonRpcError)[] = [];

  for (const message of messages) {
    const result = handleOne(message as JsonRpcRequest, ctx);
    if (result !== null) responses.push(result);
  }

  if (responses.length === 0) {
    res.writeHead(202).end();
    return;
  }

  const payload = Array.isArray(body) ? responses : responses[0];
  res
    .writeHead(200, { "content-type": "application/json; charset=utf-8" })
    .end(JSON.stringify(payload));
}

function handleOne(
  message: JsonRpcRequest,
  ctx: { readonly marker: string },
): JsonRpcSuccess | JsonRpcError | null {
  if (message.id === undefined) {
    // Notification, no response.
    return null;
  }
  const id = message.id;

  switch (message.method) {
    case "initialize":
      return success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "eve-smoke-mcp-stub", version: "0.0.0" },
      });

    case "tools/list":
      return success(id, {
        tools: [
          {
            name: "echo_marker",
            description:
              "Returns a fixed marker string supplied at server boot. Used to prove the MCP client connection round-trips a tool call end-to-end.",
            inputSchema: {
              type: "object",
              properties: {
                note: {
                  type: "string",
                  description: "Optional free-form note. Ignored by the stub.",
                },
              },
              additionalProperties: false,
            },
          },
        ],
      });

    case "tools/call": {
      const params = message.params as { name?: string } | undefined;
      if (params?.name === "echo_marker") {
        return success(id, {
          content: [{ type: "text", text: `marker:${ctx.marker}` }],
          isError: false,
        });
      }
      return errorResponse(id, -32602, `Unknown tool: ${String(params?.name)}`);
    }

    case "resources/list":
      return success(id, { resources: [] });

    case "prompts/list":
      return success(id, { prompts: [] });

    default:
      return errorResponse(id, -32601, `Method not found: ${message.method}`);
  }
}

function success(id: number | string, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: number | string, code: number, errMessage: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message: errMessage } };
}

function respondError(
  res: ServerResponse,
  id: number | string | null,
  code: number,
  errMessage: string,
): void {
  res
    .writeHead(200, { "content-type": "application/json; charset=utf-8" })
    .end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: errMessage } }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

import type { EveEvalTargetHandle } from "eve/evals";

const MCP_PATH = "/eve/v1/mcp";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const POLL_INTERVAL_MS = 500;

/** A durable invocation as the MCP channel's `agent_start` and `agent_get` report it. */
export interface McpInvocation {
  readonly invocationId: string;
  readonly result?: unknown;
  readonly status: string;
}

/** Calls one of the MCP channel's tools and returns its structured invocation state. */
export async function callMcpTool(
  target: EveEvalTargetHandle,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpInvocation> {
  const response = await target.fetch(MCP_PATH, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: { _meta: modernRequestMeta(), arguments: args, name },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    method: "POST",
  });
  const envelope = (await readJsonRpcResponse(response)) as {
    readonly result?: { readonly isError?: boolean; readonly structuredContent?: McpInvocation };
  };
  const result = envelope.result;
  if (result === undefined || result.isError === true || result.structuredContent === undefined) {
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(envelope)}`);
  }
  return result.structuredContent;
}

/** Polls `agent_get` until the invocation leaves `working`; returns every state it read. */
export async function pollInvocation(
  target: EveEvalTargetHandle,
  invocationId: string,
  timeoutMs: number,
): Promise<readonly McpInvocation[]> {
  const states: McpInvocation[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await callMcpTool(target, "agent_get", { invocationId });
    states.push(state);
    if (state.status !== "working") return states;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Invocation ${invocationId} was still working after ${String(timeoutMs)} ms.`);
}

function modernRequestMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "eve-e2e", version: "0.0.0" },
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  };
}

/** Reads a JSON-RPC response sent as plain JSON or as one server-sent event. */
async function readJsonRpcResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${String(response.status)}: ${body}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("The MCP response carried no server-sent event.");
  return JSON.parse(data.slice("data: ".length));
}

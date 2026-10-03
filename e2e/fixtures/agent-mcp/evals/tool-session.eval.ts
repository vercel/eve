import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals } from "eve/evals/expect";

import { MCP_PATH, NOTE_PATH, SERVICE_TOKEN } from "../fixture";

const MCP_PROTOCOL_VERSION = "2026-07-28";

/** One `tools/call` from a 2026-07-28 client that declares tool sessions. */
async function callTool(
  target: EveEvalTargetHandle,
  name: string,
  args: Record<string, unknown>,
  key: string,
): Promise<any> {
  const response = await target.fetch(MCP_PATH, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "dev.eve/tool-session": key,
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "dev.eve/tool-sessions": {} },
          },
          "io.modelcontextprotocol/clientInfo": { name: "front-desk", version: "0.0.0" },
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        },
        arguments: args,
        name,
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`tools/call ${name}: HTTP ${response.status}: ${body}`);
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : body;
  if (data === undefined) throw new Error(`tools/call ${name} returned no event.`);
  return JSON.parse(data).result;
}

export default defineEval({
  description: `Two MCP tool calls with one tool-session key share a sandbox: the second reads the ${NOTE_PATH} the first wrote.`,
  timeoutMs: 240_000,

  async test(t) {
    // Alice's front-desk app keeps one session for her shift.
    const key = `alice-front-desk-${crypto.randomUUID()}`;
    const text = `Feed Biscuit at 18:00 (${crypto.randomUUID()}).`;

    const wrote = await callTool(t.target, "write_note", { text }, key);
    await t.require(wrote?.structuredContent, equals({ written: text }));

    const read = await callTool(t.target, "read_note", {}, key);
    await t.require(read?.structuredContent, equals({ text }));
  },
});

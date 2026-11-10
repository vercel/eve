import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { MCP_PATH, SERVICE_TOKEN } from "../fixture";

export default defineEval({
  description:
    "Alice's front-desk client checks its identity with a normal request, then receives a tool error when an attached collection exceeds the input limit.",

  async test(t) {
    for (const length of [0, 10_000]) {
      const response = await t.target.fetch(MCP_PATH, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${SERVICE_TOKEN}`,
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "whoami",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "whoami",
            arguments: { entries: Array.from({ length }, () => 1) },
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "front-desk", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        }),
      });
      const body = (await response.json()) as {
        readonly result?: {
          readonly isError?: boolean;
          readonly content?: { readonly text?: string }[];
        };
      };
      await t.require(response.status, equals(200));
      await t.require(body.result?.isError === true, equals(length > 0));
      if (length > 0) {
        await t.require(
          body.result?.content?.[0]?.text?.includes("maximum of 10000 elements"),
          equals(true),
        );
      }
    }
  },
});

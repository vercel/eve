import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { MCP_PATH, SERVICE_TOKEN } from "../fixture";

const SKILL = "kennel-handbook";
const PROTOCOL_VERSION = "2026-07-28";

/**
 * Files a bundler or asset store would alter if it handled them by name: a
 * PNG, an empty file, and Markdown that is not valid UTF-8.
 */
const FILES = ["assets/logo.png", "references/empty.md", "references/latin1.md"];

export default defineEval({
  description:
    "Alice's front-desk client reads the kennel handbook's files over MCP and gets them byte for byte, whatever their encoding.",

  async test(t) {
    for (const path of FILES) {
      // `eve eval` runs with the fixture as cwd, so this is the authored file.
      const authored = await readFile(join(process.cwd(), "agent/skills", SKILL, path));
      const uri = `skill://${SKILL}/${path}`;
      const response = await t.target.fetch(MCP_PATH, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "resources/read",
          params: {
            uri,
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "front-desk", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            },
          },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${SERVICE_TOKEN}`,
          "content-type": "application/json",
          "mcp-method": "resources/read",
          "mcp-name": uri,
          "mcp-protocol-version": PROTOCOL_VERSION,
        },
        method: "POST",
      });
      const body = (await response.json()) as {
        readonly result?: {
          readonly contents?: { readonly blob?: string; readonly text?: string }[];
        };
      };
      const [content] = body.result?.contents ?? [];
      const served =
        content?.blob !== undefined
          ? Buffer.from(content.blob, "base64")
          : Buffer.from(content?.text ?? "\u0000missing", "utf8");
      await t.require(
        { path, bytes: served.toString("hex") },
        equals({ path, bytes: authored.toString("hex") }),
      );
    }
  },
});

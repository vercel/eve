import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

// Shapes that tool servers commonly emit and that older JSON Schema to Zod
// bridges turned into intersections and records.
const REMOTE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: { page_id: { type: "string", format: "uuid" }, title: { type: "string" } },
        anyOf: [{ required: ["page_id"] }, { required: ["title"] }],
      },
    },
    properties: { type: "object", additionalProperties: { type: ["string", "number", "null"] } },
    target: {
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { kind: { enum: ["page", "database"] } } },
      ],
    },
  },
  patternProperties: { "^x-": { type: "string" } },
  required: ["target"],
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    advertised: { type: "object" },
    results: { type: "array", items: { type: "object" } },
  },
  anyOf: [{ required: ["advertised"] }, { required: ["results"] }],
};

const VALID_REMOTE_INPUT = {
  pages: [{ page_id: "1f2e3d4c5b6a79881f2e3d4c5b6a7988" }, { title: "Weekly sync" }],
  properties: { Owner: "Bob", Points: 3 },
  target: { id: "db-1", kind: "database" },
  "x-trace": "alice",
};

describe("tool schemas in an app that pins its own Zod", () => {
  it("runs remote, authored, and structured-output schemas across Zod versions", async () => {
    const app = await scenarioApp({
      name: "tool-schemas-app-zod",
      installDependencies: true,
      // Older than the Zod eve bundles, and a version whose JSON Schema
      // conversion cannot process schemas built by eve's copy.
      dependencies: { zod: "4.4.3" },
      files: {
        "agent/instructions.md": "File the pages Alice asked for.\n",
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(({ toolResults, tools }) => {
    if (toolResults.length === 0) {
      return { toolCalls: [
        { id: "remote-valid", name: "file_pages", input: ${JSON.stringify(VALID_REMOTE_INPUT)} },
        { id: "remote-invalid", name: "file_pages", input: { pages: [{}], target: {} } },
        { id: "authored", name: "tag_page", input: { id: "page-1", tags: { status: "done" } } },
      ] };
    }
    return { toolCalls: [{ id: "final", name: "final_output", input: {
      advertised: tools.find((tool) => tool.name === "file_pages")?.inputSchema,
      results: toolResults.map(({ id, isError, output }) => ({ id, isError, output })),
    } }] };
  }),
  modelContextWindowTokens: 32000,
});
`,
        "agent/tools/file-pages.ts": `import { defineDynamic, defineTool } from "eve/tools";
export default defineDynamic({
  events: {
    "session.started": () => ({
      file_pages: defineTool({
        description: "File pages into Alice's workspace.",
        inputSchema: ${JSON.stringify(REMOTE_INPUT_SCHEMA)},
        execute: (input) => ({ filed: input }),
      }),
    }),
  },
});
`,
        "agent/tools/tag_page.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";
export default defineTool({
  description: "Tag one page.",
  inputSchema: z
    .object({ id: z.string() })
    .and(z.object({ tags: z.record(z.string(), z.string()) })),
  execute: (input) => ({ tagged: input }),
});
`,
      },
    });

    // The premise: the app's AI SDK converts schemas with the app's Zod.
    const requireFromAi = createRequire(
      realpathSync(join(app.appRoot, "node_modules", "ai", "package.json")),
    );
    const requireFromProviderUtils = createRequire(
      realpathSync(requireFromAi.resolve("@ai-sdk/provider-utils/package.json")),
    );
    expect(requireFromProviderUtils("zod/package.json")).toMatchObject({ version: "4.4.3" });

    const server = await startEveDev(app.appRoot, {
      env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
    });
    try {
      const client = new Client({ host: server.url });
      const { response } = await client.sessions.create({
        message: "Alice would like her pages filed and tagged.",
        outputSchema: OUTPUT_SCHEMA,
      });
      const result = await response.result();

      expect(result.events.some((event) => event.type === "turn.failed")).toBe(false);
      expect(server.stderr()).not.toContain("reading 'push'");
      expect(result.data).toEqual({
        advertised: REMOTE_INPUT_SCHEMA,
        results: [
          { id: "remote-valid", isError: false, output: { filed: VALID_REMOTE_INPUT } },
          { id: "remote-invalid", isError: true, output: expect.anything() },
          {
            id: "authored",
            isError: false,
            output: { tagged: { id: "page-1", tags: { status: "done" } } },
          },
        ],
      });
    } finally {
      await server.stop();
    }
  }, 360_000);
});

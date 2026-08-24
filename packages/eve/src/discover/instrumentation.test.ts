import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";
import { discoverInstrumentationSources } from "#discover/instrumentation.js";
import { createMemoryProjectSource } from "#discover/project-source.js";

describe("discoverInstrumentationSources", () => {
  it("records file and provider layouts without evaluating either", async () => {
    const source = createMemoryProjectSource({
      files: {
        "/app/agent/instrumentation.ts": 'throw new Error("must stay inert")',
        "/app/agent/instrumentation/local.ts": 'throw new Error("must stay inert")',
        "/app/agent/instrumentation/otel.mjs": 'throw new Error("must stay inert")',
      },
    });

    const result = await discoverInstrumentationSources({
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      rootEntries: await source.readDirectory("/app/agent"),
      rootPath: "/app/agent",
      source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.file).toMatchObject({
      logicalPath: "instrumentation.ts",
      sourceKind: "module",
    });
    expect(result.providers.map((provider) => provider.logicalPath)).toEqual([
      "instrumentation/local.ts",
      "instrumentation/otel.mjs",
    ]);
  });
});

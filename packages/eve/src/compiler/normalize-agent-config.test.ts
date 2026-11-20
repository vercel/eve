import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
} from "#compiler/source-graph.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { createModelMetadata } from "#internal/model-catalog.js";
import { defineAgent } from "#public/definitions/agent.js";

describe("agent model catalog diagnostics", () => {
  it("preserves the catalog transport cause when compilation fails", async () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "catalog-diagnostic",
      agentRoot: "/virtual/catalog-diagnostic/agent",
      appRoot: "/virtual/catalog-diagnostic",
    });
    const registry = createAgentSourceRegistry([
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "test:catalog-diagnostic",
          revision: "v1",
          modules: [
            {
              logicalPath: "agent.ts",
              loadNamespace: async () => ({ default: defineAgent({ model: "openai/gpt-5.4" }) }),
            },
          ],
        }),
      },
    ]);

    await expect(
      compileAgentManifest(manifest, {
        sourceRegistries: [registry],
        modelCatalog: {
          getModelLimits: async () => {
            throw error;
          },
          getByProviderModelId: async () => null,
          loadModelMetadata: async () => createModelMetadata(null),
        },
      }),
    ).rejects.toMatchObject({
      message:
        'Failed to load AI Gateway model metadata for the primary compaction trigger model "openai/gpt-5.4". fetch failed',
      cause: error,
    });
  });
});

import { describe, expect, it } from "vitest";

import { compiledAgentManifestSchema, createCompiledAgentManifest } from "#compiler/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";

describe("compiledAgentManifestSchema", () => {
  it("preserves reasoning configuration", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
        reasoning: "high",
      },
    });

    const parsed = compiledAgentManifestSchema.parse(manifest);

    expect(parsed.config.reasoning).toBe("high");
  });

  it("accepts compiled workflow world configuration", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
        name: "app",
        experimental: {
          workflow: {
            world: "@acme/eve-world",
          },
        },
      },
    });

    const parsed = compiledAgentManifestSchema.safeParse(manifest);

    expect(parsed.success).toBe(true);
    expect(manifest.config.experimental?.workflow).toEqual({ world: "@acme/eve-world" });
  });
});

import { describe, expect, it } from "vitest";

import { compiledAgentManifestSchema } from "#compiler/manifest.js";
import {
  createStubCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";
import { serializeArtifactJson } from "#protocol/artifact-json.js";

describe("serializeArtifactJson", () => {
  it("is invariant to constructor and schema property insertion order", () => {
    const constructed = createStubCompiledAgentManifest({
      agentRoot: "/virtual/app/agent",
      appRoot: "/virtual/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: { id: "openai/gpt-5.4-mini", routing: { kind: "gateway", target: "openai" } },
        name: "canonical-artifact-json",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
    });
    const reordered = Object.fromEntries(Object.entries(constructed).reverse());
    const schemaParsed = compiledAgentManifestSchema.parse(reordered);

    expect(serializeArtifactJson(reordered)).toBe(serializeArtifactJson(schemaParsed));
    expect(serializeArtifactJson({ b: { z: 1, a: 2 }, a: 3 })).toBe(
      serializeArtifactJson({ a: 3, b: { a: 2, z: 1 } }),
    );
  });
});

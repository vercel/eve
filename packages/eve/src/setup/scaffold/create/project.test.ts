import { describe, expect, it } from "vitest";

import { byokProviderEnvVar, modelProviderSlug } from "./project.js";

describe("byok provider derivation", () => {
  it("derives the provider slug from the model id prefix", () => {
    expect(modelProviderSlug("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(modelProviderSlug("openai/gpt-5.5")).toBe("openai");
  });

  it("falls back to anthropic for an id without a provider prefix", () => {
    expect(modelProviderSlug("")).toBe("anthropic");
    expect(modelProviderSlug("/model-only")).toBe("anthropic");
  });

  it("derives the env var name, uppercased with non-alphanumerics folded", () => {
    expect(byokProviderEnvVar("anthropic/claude-sonnet-5")).toBe("ANTHROPIC_API_KEY");
    expect(byokProviderEnvVar("some-lab/model")).toBe("SOME_LAB_API_KEY");
    expect(byokProviderEnvVar("meta.llama/model")).toBe("META_LLAMA_API_KEY");
  });

  it("keeps generated source valid for hostile provider prefixes", () => {
    // The slug is injected into agent.ts and the env var into process.env.<x>:
    // characters outside the slug alphabet are dropped, and a leading digit is
    // prefixed so the property access stays parseable.
    expect(modelProviderSlug('we"ird lab/model')).toBe("weirdlab");
    expect(byokProviderEnvVar("01ai/model")).toBe("_01AI_API_KEY");
  });
});

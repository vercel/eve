import { describe, expect, it } from "vitest";

import { DEFAULT_ORCAROUTER_MODEL_ID, ORCAROUTER_BASE_URL, orcarouter } from "./index.js";

describe("orcarouter", () => {
  it("defaults to the auto router model", () => {
    const model = orcarouter({ apiKey: "sk-orca-test" });
    expect(model.modelId).toBe(DEFAULT_ORCAROUTER_MODEL_ID);
  });

  it("creates a chat model under the orcarouter provider namespace", () => {
    const model = orcarouter({ apiKey: "sk-orca-test", model: "anthropic/claude-sonnet-5" });
    expect(model.modelId).toBe("anthropic/claude-sonnet-5");
    expect(model.provider).toBe("orcarouter.chat");
  });

  it("targets the OrcaRouter OpenAI-compatible endpoint", () => {
    expect(ORCAROUTER_BASE_URL).toBe("https://api.orcarouter.ai/v1");
  });

  it("rejects an empty model id", () => {
    expect(() => orcarouter({ apiKey: "sk-orca-test", model: " " })).toThrow(
      'Expected orcarouter "model" to name a gateway model id.',
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  codexModelSlugFromGatewayId,
  parseCodexModelId,
} from "#internal/model-auth/endpoint/codex/catalog.js";

describe("Codex model ids", () => {
  it("parses Codex transport ids and OpenAI Gateway model ids", () => {
    expect(parseCodexModelId("codex/gpt-5.5")).toBe("gpt-5.5");
    expect(parseCodexModelId("openai/gpt-5.5")).toBeNull();
    expect(codexModelSlugFromGatewayId("openai/gpt-5.5")).toBe("gpt-5.5");
    expect(codexModelSlugFromGatewayId("anthropic/claude-sonnet-4.6")).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  jsonSchema: vi.fn(),
}));

vi.mock("autoevals", () => ({ Factuality: vi.fn() }));

import { createAutoevalsClient } from "#evals/autoevals-client.js";

describe("createAutoevalsClient", () => {
  it("identifies eve on Gateway-routed judge calls", async () => {
    mocks.generateText.mockResolvedValueOnce({ text: "ok", toolCalls: [] });
    const client = createAutoevalsClient({ languageModel: "openai/gpt-5.5" });

    await client.chat.completions.create({ messages: [], model: "openai/gpt-5.5" });

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { "user-agent": expect.stringMatching(/^eve\/.+/) },
      }),
    );
  });
});

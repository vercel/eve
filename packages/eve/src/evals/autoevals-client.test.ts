import { afterEach, describe, expect, it, vi } from "vitest";
import { Factuality } from "autoevals";

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  jsonSchema: vi.fn(),
}));

import { createAutoevalsClient } from "#evals/autoevals-client.js";

type BraintrustGlobal = typeof globalThis & {
  __inherited_braintrust_wrap_openai?: (client: unknown) => unknown;
};

const braintrustGlobal = globalThis as BraintrustGlobal;
const originalBraintrustWrapper = braintrustGlobal.__inherited_braintrust_wrap_openai;

describe("createAutoevalsClient", () => {
  afterEach(() => {
    mocks.generateText.mockReset();
    if (originalBraintrustWrapper === undefined) {
      delete braintrustGlobal.__inherited_braintrust_wrap_openai;
    } else {
      braintrustGlobal.__inherited_braintrust_wrap_openai = originalBraintrustWrapper;
    }
  });

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

  it("retains a distinct create function when autoevals reconstructs it", () => {
    const client = createAutoevalsClient({ languageModel: "openai/gpt-5.5" });
    const Constructor = Object.getPrototypeOf(client).constructor as new (config: {
      apiKey: string;
    }) => typeof client;
    const reconstructed = new Constructor({ apiKey: "dummy" });

    expect(typeof reconstructed.chat.completions.create).toBe("function");
    expect(String(reconstructed.chat.completions.create)).not.toBe(
      String(client.chat.completions.create),
    );
  });

  it("runs a bundled autoevals judge while the Braintrust global wrapper is active", async () => {
    const { wrapOpenAI } = await import("braintrust");
    expect(braintrustGlobal.__inherited_braintrust_wrap_openai).toBe(wrapOpenAI);

    mocks.generateText.mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          input: { choice: "C" },
          toolCallId: "choice-1",
          toolName: "select_choice",
        },
      ],
    });

    const result = await Factuality({
      client: createAutoevalsClient({ languageModel: "openai/gpt-5.5" }),
      expected: "Paris",
      input: "What is the capital of France?",
      model: "openai/gpt-5.5",
      output: "Paris",
      useCoT: false,
    });

    expect(result.score).toBe(1);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });
});

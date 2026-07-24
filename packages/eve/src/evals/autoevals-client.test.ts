import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  jsonSchema: vi.fn(),
}));

vi.mock("autoevals", () => ({ Factuality: vi.fn() }));

import { createAutoevalsClient } from "#evals/autoevals-client.js";

/**
 * Mirrors autoevals `isWrapped` reconstruction (js/oai.ts): when Braintrust sets
 * `__inherited_braintrust_wrap_openai`, buildOpenAIClient probes the client by
 * reconstructing via its prototype constructor with a dummy apiKey.
 */
function reconstructLikeAutoevalsIsWrapped(client: object): unknown {
  const Constructor = Object.getPrototypeOf(client).constructor as new (options: {
    apiKey: string;
  }) => { chat?: { completions?: { create?: unknown } } };
  return new Constructor({ apiKey: "dummy" });
}

describe("createAutoevalsClient", () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
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

  it("survives autoevals isWrapped reconstruction with a callable create", () => {
    const client = createAutoevalsClient({ languageModel: "openai/gpt-5.5" });
    const reconstructed = reconstructLikeAutoevalsIsWrapped(client) as {
      chat: { completions: { create: unknown } };
    };

    expect(typeof reconstructed.chat.completions.create).toBe("function");
  });

  it("keeps live grading on generateText after a probe reconstruction", async () => {
    mocks.generateText.mockResolvedValueOnce({ text: "graded", toolCalls: [] });
    const client = createAutoevalsClient({ languageModel: "openai/gpt-5.5" });
    reconstructLikeAutoevalsIsWrapped(client);

    const result = await client.chat.completions.create({
      messages: [{ role: "user", content: "q" }],
      model: "openai/gpt-5.5",
    });

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(result.choices[0]).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({ content: "graded" }),
      }),
    );
  });

  it("documents that a plain-object bridge fails the isWrapped probe", () => {
    const plain = {
      chat: {
        completions: {
          create: async () => ({ choices: [] }),
        },
      },
    };

    const reconstructed = reconstructLikeAutoevalsIsWrapped(plain) as {
      chat?: { completions?: { create?: unknown } };
    };

    // Same property chain autoevals evaluates inside `isWrapped`.
    expect(() => String(reconstructed.chat!.completions!.create)).toThrow(
      /Cannot read properties of undefined \(reading 'completions'\)/,
    );
  });
});

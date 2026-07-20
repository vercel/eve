import { describe, expect, it } from "vitest";

import { createCodexSubscriptionModel } from "./model.js";
import { createUnsignedJwt } from "./unsigned-jwt.js";

const CODEX_ENDPOINT = "https://chatgpt.test/backend-api/codex/responses";

describe("Codex model", () => {
  it("creates an OpenAI Responses model under the Codex provider namespace", () => {
    const model = createCodexSubscriptionModel(
      { model: " gpt-5.4 " },
      {
        fetch: async () => Response.json({ ok: true }),
        readCredentials: async () => ({
          kind: "api-key",
          apiKey: "sk-test",
          authPath: "/home/user/.codex/auth.json",
          codexHome: "/home/user/.codex",
        }),
      },
    );

    expect(model).toMatchObject({
      modelId: "gpt-5.4",
      provider: "codex.responses",
      specificationVersion: "v4",
    });
  });

  it("rejects an empty Codex model id", () => {
    expect(() => createCodexSubscriptionModel({ model: " " })).toThrow(
      'Expected "model" to name a Codex model.',
    );
  });

  it("disables response storage before OpenAI Responses prompt conversion", async () => {
    const requests: RecordedRequest[] = [];
    const model = createCodexSubscriptionModel(
      { model: "gpt-5.2-codex" },
      {
        codexApiEndpoint: CODEX_ENDPOINT,
        fetch: createRecordingFetch(requests),
        readCredentials: async () => ({
          kind: "chatgpt",
          accessToken: createUnsignedJwt({ exp: 2_000_000_000 }),
          authPath: "/home/user/.codex/auth.json",
          codexHome: "/home/user/.codex",
        }),
      },
    );

    await model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "previous answer",
              providerOptions: {
                openai: {
                  itemId: "msg_070f78d118bbc2a4016a4565689d4c8190b455e3c0b74eaf90",
                  phase: "final_answer",
                },
              },
            },
          ],
        },
      ],
      providerOptions: { openai: { store: true } },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(CODEX_ENDPOINT);
    const body = JSON.parse(requests[0]?.body ?? "{}");
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "previous answer" }],
        phase: "final_answer",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("item_reference");
    expect(JSON.stringify(body)).not.toContain(
      "msg_070f78d118bbc2a4016a4565689d4c8190b455e3c0b74eaf90",
    );
  });

  it("shapes the request the way the Codex backend accepts", async () => {
    const requests: RecordedRequest[] = [];
    const model = createCodexSubscriptionModel(
      { model: "gpt-5.2-codex" },
      {
        codexApiEndpoint: CODEX_ENDPOINT,
        fetch: createRecordingFetch(requests),
        readCredentials: async () => ({
          kind: "chatgpt",
          accessToken: createUnsignedJwt({ exp: 2_000_000_000 }),
          authPath: "/home/user/.codex/auth.json",
          codexHome: "/home/user/.codex",
        }),
      },
    );

    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      maxOutputTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      providerOptions: { openai: { reasoningEffort: "medium", reasoningSummary: "auto" } },
    });

    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]?.body ?? "{}");
    // The Codex backend requires instructions at the top level and rejects a
    // `developer`/`system` role in the input array.
    expect(body.instructions).toBe("You are a helpful assistant.");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    // The system prompt is hoisted, not duplicated into the input array.
    expect(body.input).not.toContainEqual(expect.objectContaining({ role: "system" }));
    expect(body.input).not.toContainEqual(expect.objectContaining({ role: "developer" }));
    // The Codex backend rejects response storage and `max_output_tokens`, and
    // never accepts sampling parameters for reasoning models.
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    // Stateless reasoning requires the encrypted reasoning payload to be
    // echoed back, so `include` must carry it whenever reasoning is set.
    expect(body.include).toContain("reasoning.encrypted_content");
  });
});

interface RecordedRequest {
  readonly body: string | undefined;
  readonly url: string;
}

function createRecordingFetch(requests: RecordedRequest[]): typeof fetch {
  return async (input, init) => {
    requests.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      url: input instanceof Request ? input.url : input.toString(),
    });
    return Response.json({
      created_at: 0,
      id: "resp_1",
      model: "gpt-5.2-codex",
      output: [
        {
          content: [{ annotations: [], text: "ok", type: "output_text" }],
          id: "msg_new",
          role: "assistant",
          type: "message",
        },
      ],
    });
  };
}

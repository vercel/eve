import { generateText, jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";

import { createCodexSubscriptionModel } from "./model.js";
import type { CodexTokenBroker } from "./token-broker.js";

const CODEX_ENDPOINT = "https://chatgpt.test/backend-api/codex/responses";

describe("Codex model", () => {
  it("creates an OpenAI Responses model under the Codex provider namespace", () => {
    const model = createCodexSubscriptionModel(
      { model: " gpt-5.4 " },
      {
        broker: fakeBroker(),
        fetch: async () => Response.json({ ok: true }),
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

  it("streams generate calls, which the Codex backend requires", async () => {
    const requests: RecordedRequest[] = [];
    const model = createCodexSubscriptionModel(
      { model: "gpt-5.2" },
      { broker: fakeBroker(), fetch: createRecordingFetch(requests) },
    );

    const result = await generateText({
      model,
      prompt: "What is the total?",
      tools: { lookup: tool({ inputSchema: jsonSchema({ type: "object" }) }) },
    });

    expect(requests).toHaveLength(1);
    expect(result.text).toBe("ok");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ input: { q: "total" }, toolCallId: "call_1", toolName: "lookup" }),
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(result.response.id).toBe("resp_1");
  });

  it("disables response storage before OpenAI Responses prompt conversion", async () => {
    const requests: RecordedRequest[] = [];
    const model = createCodexSubscriptionModel(
      { model: "gpt-5.2-codex" },
      {
        broker: fakeBroker(),
        codexApiEndpoint: CODEX_ENDPOINT,
        fetch: createRecordingFetch(requests),
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
        content: "previous answer",
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
        broker: fakeBroker(),
        codexApiEndpoint: CODEX_ENDPOINT,
        fetch: createRecordingFetch(requests),
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

  it("requests Fast mode with the service tier the Codex backend accepts", async () => {
    const requests: RecordedRequest[] = [];
    const model = createCodexSubscriptionModel(
      { model: "gpt-6.1-sol" },
      {
        broker: fakeBroker(),
        fetch: createRecordingFetch(requests),
      },
    );

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      providerOptions: { openai: { serviceTier: "fast" } },
    });

    // OpenAI documents `fast` as an alias of `priority`, but the Codex backend
    // rejects `fast` with `400 Unsupported service_tier: fast`.
    expect(JSON.parse(requests[0]?.body ?? "{}").service_tier).toBe("priority");
  });

  it("groups summaries by reasoning item and preserves encrypted-only items", async () => {
    const requests: RecordedRequest[] = [];
    const model = createCodexSubscriptionModel(
      { model: "gpt-5.6-luna" },
      {
        broker: fakeBroker(),
        fetch: createRecordingFetch(requests),
      },
    );
    const result = await model.doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "First summary.",
              providerOptions: { openai: { itemId: "rs_1" } },
            },
            {
              type: "reasoning",
              text: "Second summary.",
              providerOptions: {
                openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-1" },
              },
            },
            {
              type: "reasoning",
              text: "",
              providerOptions: {
                openai: { itemId: "rs_2", reasoningEncryptedContent: "encrypted-2" },
              },
            },
          ],
        },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(JSON.parse(requests[0]?.body ?? "{}").input).toEqual([
      {
        type: "reasoning",
        encrypted_content: "encrypted-1",
        summary: [
          { type: "summary_text", text: "First summary." },
          { type: "summary_text", text: "Second summary." },
        ],
      },
      { type: "reasoning", encrypted_content: "encrypted-2", summary: [] },
    ]);
  });
});

function fakeBroker(): CodexTokenBroker {
  return {
    credentialOwner: () => undefined,
    getToken: async () => ({ token: "access-token" }),
    refreshState: async () => ({ kind: "ready" }),
    state: () => ({ kind: "ready" }),
  };
}

interface RecordedRequest {
  readonly body: string | undefined;
  readonly url: string;
}

// Mirrors the Codex backend, which serves only streaming requests.
function createRecordingFetch(requests: RecordedRequest[]): typeof fetch {
  return async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ body, url: input instanceof Request ? input.url : input.toString() });
    if (JSON.parse(body ?? "{}").stream !== true) {
      return Response.json(
        { detail: "Stream must be set to true" },
        { status: 400, statusText: "Bad Request" },
      );
    }
    const message = { type: "message", id: "msg_1", role: "assistant", content: [] };
    const tool = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: '{"q":"total"}',
    };
    return sseResponse([
      { type: "response.created", response: { id: "resp_1", created_at: 0, model: "gpt-5.2" } },
      { type: "response.output_item.added", output_index: 0, item: message },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "o" },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "k" },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "" } },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...tool, status: "completed" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          created_at: 0,
          model: "gpt-5.2",
          status: "completed",
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      },
    ]);
  };
}

function sseResponse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

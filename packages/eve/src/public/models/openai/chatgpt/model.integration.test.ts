import { jsonSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDurableSessionState } from "#execution/durable-session-store.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import { createCodexSubscriptionModel } from "./model.js";

afterEach(() => vi.restoreAllMocks());

interface RecordedRequest {
  readonly store: boolean;
  readonly include: string[];
  readonly input: Array<Record<string, unknown>>;
}

describe("ChatGPT streamed reasoning replay", () => {
  it("preserves all summaries and encrypted reasoning through a tool and durable history", async () => {
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const requests: RecordedRequest[] = [];
    const model = createCodexSubscriptionModel(
      { model: "gpt-5.6-luna" },
      {
        broker: {
          getToken: async () => ({ token: "test-token" }),
          refreshState: async () => ({ kind: "ready" }),
          state: () => ({ kind: "ready" }),
        },
        fetch: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return sseResponse(requests.length === 1 ? reasoningAndToolEvents() : answerEvents());
        },
      },
    );
    const execute = vi.fn(async () => ({ id: "invoice-1", total: 42 }));
    const runStep = createToolLoopHarness({
      handleEvent: async () => {},
      mode: "conversation",
      resolveModel: async () => model,
      tools: new Map([
        [
          "get_invoice",
          {
            name: "get_invoice",
            description: "Read the invoice.",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute,
          },
        ],
      ]),
    });
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "chatgpt-reasoning-test" },
        system: "Check the invoice.",
        tools: [
          {
            name: "get_invoice",
            description: "Read the invoice.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:chatgpt-reasoning-test",
      history: [],
      sessionId: "chatgpt-reasoning-test",
    };

    const first = await runStep(session, { message: "Check the invoice total." });
    expect(execute).toHaveBeenCalledOnce();
    if (typeof first.next !== "function") throw new Error("Expected a second model step.");

    const stored: ReturnType<typeof createDurableSessionState> = JSON.parse(
      JSON.stringify(createDurableSessionState({ session: first.session })),
    );
    if (stored.snapshot === undefined) throw new Error("Expected a durable snapshot.");
    const history = stored.snapshot.session.history;
    const reasoning = history.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "reasoning")
        : [],
    );
    expect(reasoning).toMatchObject([
      { text: "Checking invoice fields.", providerOptions: { openai: { itemId: "rs_1" } } },
      {
        text: "Reading the total.",
        providerOptions: {
          openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-reasoning" },
        },
      },
    ]);

    const second = await first.next({ ...first.session, history });
    expect(second.next).toBeNull();
    expect(JSON.stringify(second.session.history)).toContain("The total is 42.");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.input).toEqual(
      expect.arrayContaining([
        {
          type: "reasoning",
          encrypted_content: "encrypted-reasoning",
          summary: [
            { type: "summary_text", text: "Checking invoice fields." },
            { type: "summary_text", text: "Reading the total." },
          ],
        },
        { type: "function_call", call_id: "call_1", name: "get_invoice", arguments: "{}" },
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
          output: expect.stringContaining("invoice-1"),
        }),
      ]),
    );

    const followup = await runStep(
      { ...second.session, history: JSON.parse(JSON.stringify(second.session.history)) },
      { message: "Confirm the total." },
    );
    expect(followup.next).toBeNull();
    expect(requests).toHaveLength(3);
    const replayedReasoning = (request: RecordedRequest | undefined) =>
      request?.input.filter((item) => item.type === "reasoning");
    expect(replayedReasoning(requests[2])).toEqual(replayedReasoning(requests[1]));

    for (const request of requests) {
      expect(request.store).toBe(false);
      expect(request.include).toContain("reasoning.encrypted_content");
      expect(request.input).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: expect.anything() })]),
      );
      expect(request.input).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "item_reference" })]),
      );
    }
    expect(warnings).not.toHaveBeenCalled();
  });
});

function sseResponse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function reasoningAndToolEvents(): unknown[] {
  const events: unknown[] = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", encrypted_content: null },
    },
  ];
  for (const [summary_index, delta] of [
    "Checking invoice fields.",
    "Reading the total.",
  ].entries()) {
    events.push(
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index, delta },
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index },
    );
  }
  const tool = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "get_invoice",
    arguments: "{}",
  };
  return [
    ...events,
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-reasoning" },
    },
    { type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 1,
      delta: "{}",
    },
    { type: "response.output_item.done", output_index: 1, item: { ...tool, status: "completed" } },
    completedEvent(),
  ];
}

function answerEvents(): unknown[] {
  const item = { type: "message", id: "msg_1", role: "assistant", content: [] };
  return [
    { type: "response.output_item.added", output_index: 0, item },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      delta: "The total is 42.",
    },
    { type: "response.output_item.done", output_index: 0, item },
    completedEvent(),
  ];
}

function completedEvent(): unknown {
  return {
    type: "response.completed",
    response: {
      id: "resp_1",
      created_at: 0,
      model: "gpt-5.6-luna",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  };
}

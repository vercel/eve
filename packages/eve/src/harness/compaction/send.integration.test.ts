import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession, StepFn } from "#harness/types.js";
import { createTestKernel } from "#internal/testing/kernel.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { CompactionContext, CompactionStrategy } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

type CompactionRewrite = (
  history: readonly StoredHistoryMessage[],
  ctx: CompactionContext,
) => Promise<readonly StoredHistoryMessage[] | undefined>;

interface ResponsesBody {
  readonly input: readonly Record<string, unknown>[];
  readonly store?: boolean;
  readonly tools?: readonly { readonly name?: string }[];
}

const usage = { input_tokens: 40, output_tokens: 5 };

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" }, status: 200 });
}

const textReply = (text: string) =>
  sse([
    { type: "response.created", response: { id: "resp_text", created_at: 1, model: "gpt-5" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: text },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    { type: "response.completed", response: { usage } },
  ]);

const compactionReply = () =>
  sse([
    { type: "response.created", response: { id: "resp_cmp", created_at: 1, model: "gpt-5" } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "compaction", id: "cmp_1", encrypted_content: "ENCRYPTED-STATE" },
    },
    { type: "response.completed", response: { usage } },
  ]);

function openaiWithFetch(bodies: ResponsesBody[]) {
  const provider = createOpenAI({
    apiKey: "test",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ResponsesBody;
      bodies.push(body);
      const compacting = body.input.at(-1)?.type === "compaction_trigger";
      return compacting ? compactionReply() : textReply("The second claim cites two cases.");
    },
  });
  return provider.responses("gpt-5");
}

const lookupTool: HarnessToolDefinition = {
  description: "Looks up the sources.",
  execute: async () => "Two cases.",
  inputSchema: jsonSchema({ type: "object" }),
  name: "lookup",
};

const INJECTED: HarnessModelMessage[] = [
  { content: "MEMORY-NOTE", kind: "memory.load", role: "user" },
  { content: "INSTRUCTION-NOTE", kind: "context.instruction", role: "user" },
  { content: "STATE-NOTE", kind: "context.state", role: "user" },
  { content: "CHECKPOINT-NOTE", kind: "context.compaction", role: "user" },
  { content: "RETRY-NOTE", kind: "execution.retry", role: "user" },
];

const HISTORY: HarnessModelMessage[] = [
  { content: "Review Alice's contract.", kind: "user", role: "user" },
  ...INJECTED,
  { content: [{ text: "I reviewed it.", type: "text" }], role: "assistant" },
];

const endsInItem = (history: readonly StoredHistoryMessage[]) =>
  history.at(-1)?.role === "assistant" &&
  Array.isArray(history.at(-1)!.content) &&
  (history.at(-1)!.content as { kind?: string }[]).some(
    (part) => part.kind === "openai.compaction",
  );

const OPENAI_NATIVE: CompactionRewrite = async (history, ctx) =>
  endsInItem(history)
    ? undefined
    : await ctx.send(history, {
        providerOptions: { openai: { compactionTrigger: true, store: false } },
      });

async function turn(kernel: StepFn, session: HarnessSession, message: string) {
  let stepped = await kernel(session, { message });
  while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  return stepped.session;
}

function kernelFor(strategy: CompactionRewrite, bodies: ResponsesBody[], providers: string[] = []) {
  const wrapped: CompactionStrategy = {
    compact: async (history, ctx) => {
      providers.push(ctx.model.provider);
      return await strategy(history, ctx);
    },
    when: { "model.requested": ({ inputTokens, threshold }) => inputTokens > threshold },
  };
  return createTestKernel({
    agent: {
      compactionStrategy: wrapped,
      instructions: "You help Alice.",
      model: {
        contextWindowTokens: 4_000,
        id: "gpt-5",
        providerOptions: { openai: { store: false } },
      },
      thresholdPercent: 0.02,
    },
    handleEvent: foldingHandler(),
    resolveModel: async () => openaiWithFetch(bodies),
    tools: new Map([["lookup", lookupTool]]),
  });
}

const fresh = (): HarnessSession => ({
  compaction: {},
  continuationToken: "http:send-test",
  history: HISTORY,
  sessionId: "send-test",
});

describe("a strategy that sends the turn's own request", () => {
  it("sends the turn's instructions and tools without eve's injected messages, as the provider's own provider options ask", async () => {
    const bodies: ResponsesBody[] = [];
    const providers: string[] = [];

    await contextStorage.run(new ContextContainer(), () =>
      turn(kernelFor(OPENAI_NATIVE, bodies, providers), fresh(), "Which sources back the claim?"),
    );

    const [compacting] = bodies;
    expect(new Set(providers)).toEqual(new Set(["openai.responses"]));
    expect(compacting!.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(compacting!.store).toBe(false);
    expect(JSON.stringify(compacting!.input[0])).toContain("You help Alice.");
    expect(compacting!.tools?.map((tool) => tool.name)).toContain("lookup");
    const sent = JSON.stringify(compacting!.input);
    for (const injected of INJECTED) expect(sent).not.toContain(String(injected.content));
    expect(sent).toContain("Review Alice's contract.");
    expect(sent).toContain("I reviewed it.");
  });

  it("keeps the provider's item on the stored message, so a reloaded session still sends it", async () => {
    const bodies: ResponsesBody[] = [];
    const kernel = kernelFor(OPENAI_NATIVE, bodies);

    const session = await contextStorage.run(new ContextContainer(), () =>
      turn(kernel, fresh(), "Which sources back the claim?"),
    );

    expect(session.history).toContainEqual({
      content: [
        {
          kind: "openai.compaction",
          providerOptions: {
            openai: { encryptedContent: "ENCRYPTED-STATE", itemId: "cmp_1", type: "compaction" },
          },
          type: "custom",
        },
      ],
      role: "assistant",
    });

    const reloaded = JSON.parse(JSON.stringify(session)) as HarnessSession;
    await contextStorage.run(new ContextContainer(), () =>
      turn(kernelFor(OPENAI_NATIVE, bodies), reloaded, "And the second claim?"),
    );

    const after = bodies.at(-1)!.input;
    expect(after).toContainEqual({
      encrypted_content: "ENCRYPTED-STATE",
      id: "cmp_1",
      type: "compaction",
    });
    expect(JSON.stringify(after)).not.toContain("item_reference");
  });
});

import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, type LanguageModel } from "ai";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession, StepFn } from "#harness/types.js";
import { createTestKernel } from "#internal/testing/kernel.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type {
  CompactionRewrite,
  CompactionStrategy,
  CompactionTrigger,
} from "#shared/compaction-strategy.js";

export interface ResponsesBody {
  readonly input: readonly Record<string, unknown>[];
  readonly store?: boolean;
  readonly tools?: readonly { readonly name?: string }[];
}

export const usage = { input_tokens: 40, output_tokens: 5 };

export function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" }, status: 200 });
}

export const textReply = (text: string) =>
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

export const compactionReply = () =>
  sse([
    { type: "response.created", response: { id: "resp_cmp", created_at: 1, model: "gpt-5" } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "compaction", id: "cmp_1", encrypted_content: "ENCRYPTED-STATE" },
    },
    { type: "response.completed", response: { usage } },
  ]);

export function openaiWithFetch(
  bodies: ResponsesBody[],
  respond: (body: ResponsesBody) => Response | Promise<Response> = (body) =>
    body.input.at(-1)?.type === "compaction_trigger"
      ? compactionReply()
      : textReply("The second claim cites two cases."),
): LanguageModel {
  const provider = createOpenAI({
    apiKey: "test",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ResponsesBody;
      bodies.push(body);
      return await respond(body);
    },
  });
  return provider.responses("gpt-5");
}

export const lookupTool: HarnessToolDefinition = {
  description: "Looks up the sources.",
  execute: async () => "Two cases.",
  inputSchema: jsonSchema({ type: "object" }),
  name: "lookup",
};

export const INJECTED: HarnessModelMessage[] = [
  { content: "MEMORY-NOTE", kind: "memory.load", role: "user" },
  { content: "INSTRUCTION-NOTE", kind: "context.instruction", role: "user" },
  { content: "STATE-NOTE", kind: "context.state", role: "user" },
  { content: "CHECKPOINT-NOTE", kind: "context.compaction", role: "user" },
  { content: "RETRY-NOTE", kind: "execution.retry", role: "user" },
];

export const HISTORY: HarnessModelMessage[] = [
  { content: "Review Alice's contract.", kind: "user", role: "user" },
  ...INJECTED,
  { content: [{ text: "I reviewed it.", type: "text" }], role: "assistant" },
];

export async function turn(kernel: StepFn, session: HarnessSession, message: string) {
  let stepped = await kernel(session, { message });
  while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  return stepped.session;
}

export function kernelFor(
  strategy: CompactionRewrite,
  model: LanguageModel,
  providers: string[] = [],
  options: { readonly compactOnly?: true; readonly when?: CompactionTrigger } = {},
) {
  const wrapped: CompactionStrategy = {
    compact: async (history, ctx) => {
      providers.push(ctx.model.provider);
      return await strategy(history, ctx);
    },
    when: options.when ?? {
      "model.requested": ({ inputTokens, threshold }) => inputTokens > threshold,
    },
  };
  return createTestKernel({
    ...(options.compactOnly && { compactOnly: true }),
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
    resolveModel: async () => model,
    tools: new Map([["lookup", lookupTool]]),
  });
}

export const fresh = (): HarnessSession => ({
  compaction: {},
  continuationToken: "http:send-test",
  history: HISTORY,
  sessionId: "send-test",
});

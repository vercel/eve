import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, type LanguageModel } from "ai";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession, StepFn } from "#harness/types.js";
import { createTestKernel } from "#internal/testing/kernel.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { CompactionStrategy } from "#shared/compaction-strategy.js";

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

export const compactionReply = (id = "cmp_1", encrypted = "ENCRYPTED-STATE") =>
  sse([
    { type: "response.created", response: { id: "resp_cmp", created_at: 1, model: "gpt-5" } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "compaction", id, encrypted_content: encrypted },
    },
    { type: "response.completed", response: { usage } },
  ]);

export const functionCallReply = (callId: string) => {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name: "lookup",
    arguments: "{}",
    status: "completed",
  };
  return sse([
    { type: "response.created", response: { id: "resp_call", created_at: 1, model: "gpt-5" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: "{}",
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { usage } },
  ]);
};

export const contextOverflowReply = (): globalThis.Response =>
  new Response(
    JSON.stringify({
      error: {
        code: "context_length_exceeded",
        message: "Your input exceeds the context window of this model.",
        type: "invalid_request_error",
      },
    }),
    { headers: { "content-type": "application/json" }, status: 400 },
  );

const storedIdsOf = async (response: Response): Promise<string[]> =>
  (await response.clone().text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>)
    .flatMap((event) => {
      const item = event.item as { id?: unknown } | undefined;
      return event.type === "response.output_item.done" && typeof item?.id === "string"
        ? [item.id]
        : [];
    });

export const isCompactionTrigger = (body: ResponsesBody) =>
  body.input.at(-1)?.type === "compaction_trigger";

export function openaiWithFetch(
  bodies: ResponsesBody[],
  respond: (body: ResponsesBody) => Response | Promise<Response> = (body) =>
    isCompactionTrigger(body) ? compactionReply() : textReply("The second claim cites two cases."),
): LanguageModel {
  const stored = new Set<string>();
  const provider = createOpenAI({
    apiKey: "test",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ResponsesBody;
      bodies.push(body);
      const missing = body.input.find(
        (entry) => entry.type === "item_reference" && !stored.has(String(entry.id)),
      );
      if (missing !== undefined) {
        return new Response(
          JSON.stringify({
            error: {
              message: `Item with id '${String(missing.id)}' not found.`,
              type: "invalid_request_error",
            },
          }),
          { headers: { "content-type": "application/json" }, status: 404 },
        );
      }
      const response = await respond(body);
      if (body.store !== false && response.ok) {
        for (const id of await storedIdsOf(response)) stored.add(id);
      }
      return response;
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
  strategy: CompactionStrategy,
  model: LanguageModel,
  providers: string[] = [],
  options: {
    readonly compactOnly?: true;
    readonly gatewayOptions?: { readonly only?: readonly string[] };
    readonly openaiOptions?: { readonly store?: boolean };
  } = {},
) {
  const wrapped: CompactionStrategy = async (history, ctx) => {
    providers.push(ctx.model.provider);
    return await strategy(history, ctx);
  };
  return createTestKernel({
    ...(options.compactOnly && { compactOnly: true }),
    agent: {
      compactionStrategy: wrapped,
      instructions: "You help Alice.",
      model: {
        contextWindowTokens: 4_000,
        id: "gpt-5",
        providerOptions: {
          ...(options.gatewayOptions && { gateway: options.gatewayOptions }),
          openai: options.openaiOptions ?? { store: false },
        },
      },
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

import {
  type CompactionContext,
  CompactionOverflowError,
  type CompactionStrategy,
  type CompactionSummaryOptions,
  type StoredHistoryMessage as HistoryMessage,
} from "eve/compaction";

export const CHECKPOINT_MARKER = "<marker>";

export function estimate(messages: readonly HistoryMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function fakeContext(input: {
  readonly limit: number;
  readonly reason?: CompactionContext["reason"];
  readonly phase?: CompactionContext["phase"];
  readonly model?: CompactionContext["model"];
  /** Summary requests over this many tokens reject as overflowing. */
  readonly summaryLimit?: number;
}) {
  const calls: { messages: readonly HistoryMessage[]; options?: CompactionSummaryOptions }[] = [];
  const ctx: CompactionContext = {
    reason: input.reason ?? "automatic",
    phase: input.phase ?? "step",
    session: { id: "s1" },
    change: { changeId: "c1" },
    model: input.model ?? { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
    tokens: { limit: input.limit, estimate },
    async summarize(messages, options) {
      calls.push({ messages, options });
      if (input.summaryLimit !== undefined && estimate(messages) > input.summaryLimit) {
        throw new CompactionOverflowError({ cause: undefined });
      }
      return "SUMMARY";
    },
    checkpoint: (summary) => [
      { role: "user", kind: "context.compaction", content: CHECKPOINT_MARKER },
      { role: "assistant", content: summary },
    ],
    abortSignal: new AbortController().signal,
  };
  return { ctx, calls };
}

export function compactOf(strategy: CompactionStrategy) {
  return typeof strategy === "function" ? strategy : strategy.compact;
}

export function dueOf(strategy: CompactionStrategy) {
  if (typeof strategy === "function" || strategy.when?.due === undefined)
    throw new Error("no trigger");
  return strategy.when.due;
}

export function user(text: string): HistoryMessage {
  return { role: "user", kind: "user", content: text };
}

export function toolTurn(id: string, output: string): HistoryMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: { cmd: id } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "bash",
          output: { type: "text", value: output },
        },
      ],
    },
  ];
}

export function pairsIntact(history: readonly HistoryMessage[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of history) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type === "tool-result") results.add(part.toolCallId);
    }
  }
  return [...calls].every((id) => results.has(id)) && [...results].every((id) => calls.has(id));
}

export function ids(history: readonly HistoryMessage[]): string[] {
  return history.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : [])),
  );
}

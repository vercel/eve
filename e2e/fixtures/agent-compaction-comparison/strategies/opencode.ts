import type {
  CompactionContext,
  CompactionMeasure,
  CompactionStrategy,
  CompactionSummaryOptions,
  StoredHistoryMessage,
} from "eve/compaction";

// Ported from anomalyco/opencode v1.19.5 @ 810c0eba: packages/opencode/src/session/compaction.ts,
// overflow.ts and prompt.ts, with the prompt from packages/core/src/session/compaction.ts.

export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
const PRUNE_PROTECTED_TOOLS = ["skill"];
export const PRUNE_MARKER = "[Old tool result content cleared]";
const TOOL_OUTPUT_MAX_CHARS = 2_000;
const MIN_PRESERVE_RECENT_TOKENS = 2_000;
const MAX_PRESERVE_RECENT_TOKENS = 15_000;
/** `ProviderTransform.maxOutputTokens`: a model's output limit, capped at 32k. */
export const OUTPUT_TOKEN_MAX = 32_000;
export const CONTINUE_PROMPT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

export const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`;

export interface OpencodeCompactionOptions {
  /** `compaction.reserved`: tokens kept free below the window. Defaults to the model's output limit, at most 32k. */
  readonly reserved?: number;
  /** `compaction.preserve_recent_tokens`. Defaults to clamp(25% of the usable window, 2k, 15k). */
  readonly preserveRecentTokens?: number;
  /** `compaction.prune`: clear old tool outputs after each turn. */
  readonly prune?: boolean;
  readonly pruneProtect?: number;
  readonly pruneMinimum?: number;
  readonly model?: CompactionSummaryOptions["model"];
}

/** `usable()`: the window less the output reserve. eve has no separate input limit, so this is opencode's `limit.context` path. */
export function usable(
  measure: Pick<CompactionMeasure, "contextWindowTokens" | "maxOutputTokens">,
  reserved?: number,
): number {
  const output = Math.min(measure.maxOutputTokens ?? OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX);
  return Math.max(0, measure.contextWindowTokens - (reserved ?? output));
}

export function opencodeCompaction(options: OpencodeCompactionOptions = {}): CompactionStrategy {
  return {
    when: {
      phases: options.prune ? ["step", "turn-end"] : ["step"],
      due: (measure) =>
        measure.phase === "turn-end" || measure.inputTokens >= usable(measure, options.reserved),
    },
    async compact(history, ctx) {
      if (ctx.phase === "turn-end") return prune(history, ctx, options);
      const budget =
        options.preserveRecentTokens ??
        clamp(
          Math.floor(usable(ctx.model, options.reserved) * 0.25),
          MIN_PRESERVE_RECENT_TOKENS,
          MAX_PRESERVE_RECENT_TOKENS,
        );
      let messages = history;
      let replay: StoredHistoryMessage | undefined;
      if (ctx.reason === "overflow") {
        const at = history.findLastIndex(isPerson);
        if (at > 0 && history.slice(0, at).some(isPerson)) {
          replay = history[at];
          messages = history.slice(0, at);
        }
      }
      const { previousSummary, rest } = withoutCheckpoint(messages);
      const { head, tail } = select(rest, budget, ctx);
      const conversation = head.map(serialize).filter(Boolean).join("\n\n");
      const summary = await ctx.summarize([], {
        model: options.model,
        prompt: buildPrompt({ context: [conversation], previousSummary }),
        system: "",
      });
      const after: StoredHistoryMessage[] =
        replay !== undefined
          ? [replay]
          : ctx.reason === "manual"
            ? []
            : [{ content: CONTINUE_PROMPT, kind: "execution.continuation", role: "user" }];
      return [...ctx.checkpoint(summary), ...tail, ...after];
    },
  };
}

export function buildPrompt(input: {
  readonly previousSummary?: string;
  readonly context: readonly string[];
}): string {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`;
  if (!input.previousSummary) {
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n");
  }
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n");
}

/** Splits off a `ctx.checkpoint()` head: the summary it holds, and the history after it. */
function withoutCheckpoint(history: readonly StoredHistoryMessage[]): {
  previousSummary?: string;
  rest: readonly StoredHistoryMessage[];
} {
  const [marker, summary] = history;
  if (
    marker?.role !== "user" ||
    marker.kind !== "context.compaction" ||
    summary?.role !== "assistant"
  ) {
    return { rest: history };
  }
  return { previousSummary: textOf(summary.content), rest: history.slice(2) };
}

/** `select()`: the newest whole turns within `budget`, or the end of the newest turn that doesn't fit. */
export function select(
  messages: readonly StoredHistoryMessage[],
  budget: number,
  ctx: Pick<CompactionContext, "tokens">,
): { head: readonly StoredHistoryMessage[]; tail: readonly StoredHistoryMessage[] } {
  const starts = messages.flatMap((message, index) => (isPerson(message) ? [index] : []));
  let total = 0;
  let keep: number | undefined;
  for (let turn = starts.length - 1; turn >= 0; turn--) {
    const start = starts[turn]!;
    const end = starts[turn + 1] ?? messages.length;
    const size = ctx.tokens.estimate(messages.slice(start, end));
    if (total + size <= budget) {
      total += size;
      keep = start;
      continue;
    }
    keep = splitTurn(messages, start, end, budget - total, ctx) ?? keep;
    break;
  }
  if (keep === undefined || keep === 0) return { head: messages, tail: [] };
  return { head: messages.slice(0, keep), tail: messages.slice(keep) };
}

/**
 * `splitTurn()`: the earliest message after the turn's input whose rest of the turn fits. opencode
 * keeps a call and its result in one message; here a tool message never starts the tail, so it
 * stays with its call.
 */
function splitTurn(
  messages: readonly StoredHistoryMessage[],
  start: number,
  end: number,
  budget: number,
  ctx: Pick<CompactionContext, "tokens">,
): number | undefined {
  if (budget <= 0 || end - start <= 1) return undefined;
  for (let at = start + 1; at < end; at++) {
    if (messages[at]!.role === "tool") continue;
    if (ctx.tokens.estimate(messages.slice(at, end)) <= budget) return at;
  }
  return undefined;
}

/** `serialize()`: a message as transcript text, tool outputs cut to 2,000 characters. */
export function serialize(message: StoredHistoryMessage): string {
  if (message.role === "system") return "";
  if (message.role === "user") {
    const text = textOf(message.content);
    if (message.kind !== "user") return "";
    const files = typeof message.content === "string" ? [] : attachments(message.content);
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n");
  }
  if (typeof message.content === "string") {
    return message.content ? `[Assistant]: ${message.content}` : "";
  }
  return message.content
    .flatMap((part) => {
      switch (part.type) {
        case "text":
          return part.text ? [`[Assistant]: ${part.text}`] : [];
        case "reasoning":
          return part.text ? [`[Assistant reasoning]: ${part.text}`] : [];
        case "tool-call":
          return [`[Assistant tool call]: ${part.toolName}(${JSON.stringify(part.input)})`];
        case "tool-result": {
          const output = outputText(part.output);
          const attached = part.output.type === "content" ? attachments(part.output.value) : [];
          return [
            output === PRUNE_MARKER
              ? `[Tool result]: ${PRUNE_MARKER}`
              : part.output.type.startsWith("error")
                ? `[Tool error]: ${output}`
                : `[Tool result]: ${truncate([output, ...attached].join("\n"))}`,
          ];
        }
        default:
          return [];
      }
    })
    .join("\n");
}

/** Clears old tool outputs past the newest `pruneProtect` tokens outside the last two turns, if that frees more than `pruneMinimum`. */
export function prune(
  history: readonly StoredHistoryMessage[],
  ctx: Pick<CompactionContext, "tokens">,
  limits: { readonly pruneProtect?: number; readonly pruneMinimum?: number } = {},
): readonly StoredHistoryMessage[] | undefined {
  const protect = limits.pruneProtect ?? PRUNE_PROTECT;
  const minimum = limits.pruneMinimum ?? PRUNE_MINIMUM;
  const names = toolNames(history);
  const candidates = new Set<string>();
  let turns = 0;
  let total = 0;
  let pruned = 0;
  loop: for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role === "user" && message.kind === "user") turns++;
    if (turns < 2) continue;
    if (message.role === "assistant" && isCheckpointSummary(history, index)) break;
    if (message.role !== "tool") continue;
    for (const part of [...message.content].reverse()) {
      if (part.type !== "tool-result" || part.output.type.startsWith("error")) continue;
      if (PRUNE_PROTECTED_TOOLS.includes(names.get(part.toolCallId) ?? "")) continue;
      const output = outputText(part.output);
      if (output === PRUNE_MARKER) break loop;
      const estimate = Math.ceil(output.length / 4);
      total += estimate;
      if (total <= protect) continue;
      pruned += estimate;
      candidates.add(part.toolCallId);
    }
  }
  if (pruned <= minimum) return undefined;
  return history.map((message) => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result" && candidates.has(part.toolCallId)
          ? { ...part, output: { type: "text" as const, value: PRUNE_MARKER } }
          : part,
      ),
    };
  });
}

function isPerson(message: StoredHistoryMessage): boolean {
  return message.role === "user" && message.kind === "user";
}

function isCheckpointSummary(history: readonly StoredHistoryMessage[], index: number): boolean {
  const before = history[index - 1];
  return index === 1 && before?.role === "user" && before.kind === "context.compaction";
}

function toolNames(history: readonly StoredHistoryMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of history) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") names.set(part.toolCallId, part.toolName);
    }
  }
  return names;
}

function textOf(content: StoredHistoryMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function outputText(output: { readonly type: string; readonly value?: unknown }): string {
  if (output.type === "content" && Array.isArray(output.value)) {
    return textOf(output.value as { type: "text"; text: string }[]);
  }
  return typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? "");
}

/** opencode's `[Attached <mime>: <filename>]` line for each file a message or tool result carries. */
function attachments(
  parts: readonly {
    readonly type: string;
    readonly mediaType?: string;
    readonly filename?: string;
  }[],
): string[] {
  return parts.flatMap((part) =>
    part.type === "text"
      ? []
      : [`[Attached ${part.mediaType ?? part.type}: ${part.filename ?? "file"}]`],
  );
}

function truncate(value: string): string {
  return value.length <= TOOL_OUTPUT_MAX_CHARS
    ? value
    : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

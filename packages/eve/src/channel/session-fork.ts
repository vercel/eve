import type { AssistantContent, ModelMessage, ToolContent } from "ai";
import { transcriptOf } from "#client/transcript.js";
import { createUserMessage, IMPORTED_MESSAGE_METADATA_KEY } from "#harness/messages.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import {
  conversation,
  emptySessionView,
  foldEvents,
} from "#protocol/session-projection/public-view.js";
import type { SessionForkSeed } from "#shared/session-fork.js";
import type { JsonValue } from "#shared/json.js";

const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
const MAX_SEED_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 200;

type ToolCallPart = Extract<Exclude<AssistantContent, string>[number], { type: "tool-call" }>;
type ToolResultPart = Extract<ToolContent[number], { type: "tool-result" }>;

interface TurnMessages {
  readonly turnId: string;
  readonly messages: ModelMessage[];
}

export class SessionForkError extends Error {
  override readonly name = "SessionForkError";
}

export async function readSessionForkSeed(source: {
  readonly id: string;
  stream(options: { readonly follow: false }): AsyncIterable<SessionStreamEvent>;
}): Promise<SessionForkSeed> {
  const events: SessionStreamEvent[] = [];
  for await (const event of source.stream({ follow: false })) events.push(event);
  if (events.length === 0) {
    throw new SessionForkError(`Session "${source.id}" has no recorded conversation to fork.`);
  }
  return sessionForkSeed(source.id, events);
}

export function sessionForkSeed(
  sessionId: string,
  events: readonly SessionStreamEvent[],
): SessionForkSeed {
  const selected = new Set(
    conversation(foldEvents(emptySessionView(), events)).map((turn) => turn.turnId),
  );
  const turns = new Map<string, TurnMessages>();
  const builders = new Map<string, TurnBuilder>();
  const callNames = new Map<string, string>();
  const builderFor = (turnId: string) => {
    let builder = builders.get(turnId);
    if (builder === undefined) {
      const entry = { messages: [], turnId };
      turns.set(turnId, entry);
      builder = new TurnBuilder(entry.messages);
      builders.set(turnId, builder);
    }
    return builder;
  };
  for (const event of events) {
    switch (event.type) {
      case "delivery.consumed": {
        if (!selected.has(event.data.turnId)) break;
        const builder = builderFor(event.data.turnId);
        for (const entry of event.data.history ?? []) builder.imported(entry.role, entry.text);
        const text = userText(event.data.parts);
        if (text.length > 0) builder.user(text);
        break;
      }
      case "content.completed": {
        const turnId = event.scope?.turnId;
        if (turnId === undefined || !selected.has(turnId)) break;
        if (event.data.kind !== "text" || event.data.interrupted === true) break;
        if (typeof event.data.value === "string" && event.data.value.trim().length > 0) {
          builderFor(turnId).assistantText(event.data.value);
        }
        break;
      }
      case "call.requested": {
        const turnId = event.scope?.turnId;
        if (turnId === undefined || !selected.has(turnId)) break;
        if (!("runId" in event.data.owner) || event.data.capability.kind === "control") break;
        callNames.set(event.data.callId, event.data.capability.name);
        builderFor(turnId).toolCall({
          input: event.data.input ?? {},
          toolCallId: event.data.callId,
          toolName: event.data.capability.name,
          type: "tool-call",
        });
        break;
      }
      case "call.settled": {
        const toolName = callNames.get(event.data.callId);
        const turnId = event.scope?.turnId;
        if (toolName === undefined || turnId === undefined) break;
        builderFor(turnId).toolResult({
          output: toolOutput(event.data),
          toolCallId: event.data.callId,
          toolName,
          type: "tool-result",
        });
        break;
      }
    }
  }
  for (const builder of builders.values()) builder.finish();
  const ordered = [...turns.values()].filter((turn) => turn.messages.length > 0);
  return {
    messages: withinBudget(ordered),
    source: { sessionId },
    transcript: transcriptOf(events, { maxMessages: MAX_TRANSCRIPT_MESSAGES }).messages.map(
      ({ role, text }) => ({ role, text }),
    ),
  };
}

class TurnBuilder {
  readonly #messages: ModelMessage[];
  #assistant: Exclude<AssistantContent, string>[number][] | undefined;
  #calls: ToolCallPart[] = [];
  #results = new Map<string, ToolResultPart>();

  constructor(messages: ModelMessage[]) {
    this.#messages = messages;
  }

  imported(role: "user" | "assistant", text: string): void {
    if (role === "user") this.user(text);
    else this.assistantText(text);
  }

  user(text: string): void {
    this.#flush();
    this.#messages.push(createUserMessage("user", text, { [IMPORTED_MESSAGE_METADATA_KEY]: true }));
  }

  assistantText(text: string): void {
    if (this.#calls.length > 0) this.#flush();
    (this.#assistant ??= []).push({ text, type: "text" });
  }

  toolCall(part: ToolCallPart): void {
    (this.#assistant ??= []).push(part);
    this.#calls.push(part);
  }

  toolResult(part: ToolResultPart): void {
    this.#results.set(part.toolCallId, part);
  }

  finish(): void {
    this.#flush();
  }

  #flush(): void {
    if (this.#assistant === undefined) return;
    this.#messages.push({ content: this.#assistant, role: "assistant" });
    if (this.#calls.length > 0) {
      this.#messages.push({
        content: this.#calls.map(
          (call) =>
            this.#results.get(call.toolCallId) ?? {
              output: { type: "error-text", value: "No result was recorded for this call." },
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              type: "tool-result",
            },
        ),
        role: "tool",
      });
    }
    this.#assistant = undefined;
    this.#calls = [];
    this.#results = new Map();
  }
}

function userText(parts: readonly UserPart[]): string {
  return parts
    .map((part) =>
      part.kind === "text" ? part.text : `[Attached file: ${part.filename ?? part.mediaType}]`,
    )
    .join("\n")
    .trim();
}

function toolOutput(data: {
  readonly error?: { readonly message: string };
  readonly outcome: string;
  readonly output?: JsonValue;
  readonly outputRef?: unknown;
}): ToolResultPart["output"] {
  if (data.error !== undefined) return { type: "error-text", value: data.error.message };
  if (data.output === undefined) {
    return {
      type: "text",
      value: data.outputRef === undefined ? `(${data.outcome})` : "(output not recorded)",
    };
  }
  const serialized =
    typeof data.output === "string" ? data.output : (JSON.stringify(data.output) ?? "null");
  if (serialized.length > MAX_TOOL_OUTPUT_BYTES) {
    return { type: "text", value: `${serialized.slice(0, MAX_TOOL_OUTPUT_BYTES)}… [truncated]` };
  }
  return typeof data.output === "string"
    ? { type: "text", value: data.output }
    : { type: "json", value: data.output };
}

function withinBudget(turns: readonly TurnMessages[]): ModelMessage[] {
  const kept: TurnMessages[] = [];
  let bytes = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    bytes += JSON.stringify(turn.messages).length;
    if (bytes > MAX_SEED_BYTES && kept.length > 0) break;
    kept.unshift(turn);
  }
  return kept.flatMap((turn) => turn.messages);
}

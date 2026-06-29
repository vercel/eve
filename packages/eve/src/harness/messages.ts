import type { ModelMessage, TextPart, UserContent } from "ai";

import type { DeliverPayload, SessionAuthContext } from "#channel/types.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { StepInput } from "#harness/types.js";

/**
 * Merges two {@link StepInput} values into one.
 *
 * Used by the harness to coalesce deferred step input with the current
 * turn's input, and by the execution layer after calling `onDeliver`
 * for each queued delivery payload.
 */
export function coalesceTurnInputs(a: StepInput, b: StepInput): StepInput {
  const inputResponses = coalesceInputResponses({
    a: a.inputResponses,
    b: b.inputResponses,
  });
  const message = coalesceMessage({
    a: a.message,
    b: b.message,
  });
  const context = coalesceContext({
    a: a.context,
    b: b.context,
  });
  const outputSchema = b.outputSchema ?? a.outputSchema;

  const result: {
    inputResponses?: readonly InputResponse[];
    message?: string | UserContent;
    context?: readonly string[];
    outputSchema?: StepInput["outputSchema"];
  } = {};

  if (inputResponses !== undefined) {
    result.inputResponses = inputResponses;
  }

  if (message !== undefined) {
    result.message = message;
  }

  if (context !== undefined) {
    result.context = context;
  }

  if (outputSchema !== undefined) {
    result.outputSchema = outputSchema;
  }

  return result;
}

/**
 * Extracts the final visible assistant text from model response messages.
 *
 * Prefers text extracted from the last assistant message that contains visible
 * text. Falls back to the raw `text` property from the AI SDK result when no
 * assistant message contains text. Returns `null` when neither source contains
 * text.
 */
export function resolveAssistantStepText(
  messages: readonly ModelMessage[],
  fallback: string | undefined,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const text = extractMessageText(message);
    if (text.trim().length > 0) {
      return text;
    }
  }

  if (fallback !== undefined && fallback.trim().length > 0) {
    return fallback;
  }

  return null;
}

function extractMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }

      return "type" in part && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [];
    })
    .join("");
}

function coalesceInputResponses(input: {
  readonly a?: readonly InputResponse[];
  readonly b?: readonly InputResponse[];
}): readonly InputResponse[] | undefined {
  const a = input.a ?? [];
  const b = input.b ?? [];

  if (a.length === 0 && b.length === 0) {
    return undefined;
  }

  return [...a, ...b];
}

function coalesceContext(input: {
  readonly a?: readonly string[];
  readonly b?: readonly string[];
}): readonly string[] | undefined {
  const a = input.a ?? [];
  const b = input.b ?? [];

  if (a.length === 0 && b.length === 0) {
    return undefined;
  }

  return [...a, ...b];
}

/**
 * Merges two optional turn messages into one.
 *
 * When both sides are strings, concatenates with a blank line. When
 * either side is a structured {@link UserContent} array, promotes both
 * to arrays and concatenates their parts so attachments carried on the
 * deferred or newer input are preserved end-to-end.
 */
function coalesceMessage(input: {
  readonly a?: string | UserContent;
  readonly b?: string | UserContent;
}): string | UserContent | undefined {
  if (input.a === undefined) {
    return input.b;
  }

  if (input.b === undefined) {
    return input.a;
  }

  if (typeof input.a === "string" && typeof input.b === "string") {
    return `${input.a}\n\n${input.b}`;
  }

  const merged: UserContentArray = [...toUserContentArray(input.a), ...toUserContentArray(input.b)];
  return merged;
}

type UserContentArray = Exclude<UserContent, string>;

function toUserContentArray(value: string | UserContent): UserContentArray {
  if (typeof value === "string") {
    return value.length > 0 ? [{ type: "text", text: value } satisfies TextPart] : [];
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  return [];
}

/**
 * Structural shape of the workflow `DeliverHookPayload`. Using a
 * structural type keeps this helper decoupled from the concrete
 * runtime type.
 */
interface DeliverLike {
  readonly auth?: SessionAuthContext | null;
  readonly kind: "deliver";
  readonly payloads: readonly DeliverPayload[];
}

/**
 * Coalesces an array of deliver-like items into a single item by
 * collecting all payloads and keeping the most recent auth value.
 *
 * Used by the workflow runtime to batch follow-up deliveries that
 * arrived while a turn or subagent delegation was in progress. Each
 * payload is later passed to `onDeliver` individually so channel-
 * specific fields are never lost.
 */
export function coalesceDeliveries<T extends DeliverLike>(items: readonly T[]): T {
  const [first, ...rest] = items;

  if (first === undefined) {
    throw new Error("Cannot coalesce an empty delivery batch.");
  }

  let auth = first.auth;
  const payloads = [...first.payloads];

  for (const item of rest) {
    if (item.auth !== undefined) {
      auth = item.auth;
    }
    payloads.push(...item.payloads);
  }

  return { ...first, auth, payloads };
}

import { toJsonValue } from "#harness/call-facts.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { ToolReplyDefinition } from "#tools/definition.js";

// A tool's reply part: what a call adds to its turn's reply, previewed from the call's input
// while the model writes it and completed from the tool's `reply.part` once the call succeeds.

/** The part a call writes. One per call, so the call names it. */
export function replyPartId(callId: string): string {
  return `${callId}.reply`;
}

/**
 * The `content.completed` a successful call adds to its turn's reply, or `undefined` when its
 * `reply.part` returns `null`. Throws when `part` throws or returns something that isn't a part.
 */
export async function replyPartOf(
  reply: ToolReplyDefinition<any, any>,
  callId: string,
  input: unknown,
  output: unknown,
): Promise<FactOf<"content.completed">["data"] | undefined> {
  const part = await reply.part(input as Readonly<object>, output);
  if (part === null) return undefined;
  if (typeof part !== "object" || typeof part.fallbackText !== "string") {
    throw new TypeError(
      'A tool\'s "reply.part" must return { value, fallbackText } with fallbackText as a string, or null.',
    );
  }
  return {
    callId,
    fallbackText: part.fallbackText,
    kind: reply.kind,
    ...(reply.mediaType !== undefined && { mediaType: reply.mediaType }),
    partId: replyPartId(callId),
    phase: "reply",
    value: toJsonValue(part.value),
  };
}

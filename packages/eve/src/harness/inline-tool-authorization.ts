import type { ModelMessage } from "ai";

import {
  type AuthorizationSignal,
} from "#harness/authorization.js";
import { resolveActiveAuthorizationChallenges } from "#harness/hitl/sign-ins.js";

/**
 * Resolves the sign-ins that stopped calls, and keeps only protocol-complete sibling calls from
 * the response that made them.
 */
export function resolveInlineAuthorizationInterrupt(input: {
  readonly messages: readonly ModelMessage[];
  readonly signIns: readonly { readonly callId: string; readonly signal: AuthorizationSignal }[];
}):
  | {
      readonly challenges: AuthorizationSignal["challenges"];
      /** The calls each sign-in stopped, by the challenge's connection name. */
      readonly callIdsByName: ReadonlyMap<string, readonly string[]>;
      readonly history: ModelMessage[];
    }
  | undefined {
  if (input.signIns.length === 0) return undefined;
  const callIdsByName = new Map<string, string[]>();
  for (const { callId, signal } of input.signIns) {
    for (const challenge of signal.challenges) {
      callIdsByName.set(challenge.name, [...(callIdsByName.get(challenge.name) ?? []), callId]);
    }
  }
  return {
    callIdsByName,
    challenges: resolveActiveAuthorizationChallenges(
      input.signIns.flatMap(({ signal }) => signal.challenges),
    ),
    history: withoutCalls(input.messages, new Set(input.signIns.map(({ callId }) => callId))),
  };
}

/** Drops the given calls and their results, keeping protocol-complete sibling calls. */
export function withoutCalls(
  messages: readonly ModelMessage[],
  interruptedCallIds: ReadonlySet<string>,
): ModelMessage[] {
  const projected = messages.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const interrupted = message.content.some(
        (part) => part.type === "tool-call" && interruptedCallIds.has(part.toolCallId),
      );
      const content = message.content.filter(
        (part) => part.type !== "tool-call" || !interruptedCallIds.has(part.toolCallId),
      );
      const hasSiblingCall = content.some((part) => part.type === "tool-call");
      return content.length === 0 || (interrupted && !hasSiblingCall)
        ? []
        : [{ ...message, content }];
    }
    if (message.role === "tool") {
      const content = message.content.filter(
        (part) => part.type !== "tool-result" || !interruptedCallIds.has(part.toolCallId),
      );
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    return [message];
  });

  return projected;
}

import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import { contextStorage } from "#context/container.js";
import {
  type AuthorizationSignal,
  isAuthorizationSignal,
  isPendingAuthorizationToolOutput,
} from "#harness/authorization.js";
import { resolveActiveAuthorizationChallenges } from "#harness/hitl/sign-ins.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";

/** Returns whether an inline tool result represents a pending authorization interrupt. */
export function isInlineAuthorizationToolResult(toolResult: TypedToolResult<ToolSet>): boolean {
  return (
    isPendingAuthorizationToolOutput(toolResult.output) ||
    readAuthorizationSignal(toolResult) !== undefined
  );
}

/**
 * Resolves authorization interrupts and keeps only protocol-complete sibling
 * calls from the response that produced them.
 */
export function resolveInlineAuthorizationInterrupt(input: {
  readonly messages: readonly ModelMessage[];
  readonly toolResults: readonly TypedToolResult<ToolSet>[] | undefined;
}):
  | {
      readonly challenges: AuthorizationSignal["challenges"];
      /** The calls each sign-in stopped, by the challenge's connection name. */
      readonly callIdsByName: ReadonlyMap<string, readonly string[]>;
      readonly history: ModelMessage[];
    }
  | undefined {
  const signals: AuthorizationSignal[] = [];
  const interruptedCallIds = new Set<string>();
  const callIdsByName = new Map<string, string[]>();

  for (const toolResult of input.toolResults ?? []) {
    const signal = readAuthorizationSignal(toolResult);
    if (signal === undefined) continue;
    signals.push(signal);
    interruptedCallIds.add(toolResult.toolCallId);
    for (const challenge of signal.challenges) {
      const callIds = callIdsByName.get(challenge.name) ?? [];
      callIdsByName.set(challenge.name, [...callIds, toolResult.toolCallId]);
    }
  }

  if (signals.length === 0) return undefined;

  return {
    callIdsByName,
    challenges: resolveActiveAuthorizationChallenges(
      signals.flatMap((signal) => signal.challenges),
    ),
    history: withoutCalls(input.messages, interruptedCallIds),
  };
}

function readAuthorizationSignal(
  toolResult: TypedToolResult<ToolSet>,
): AuthorizationSignal | undefined {
  const ctx = contextStorage.getStore();
  const stashed = ctx === undefined ? undefined : readToolInterrupt(ctx, toolResult.toolCallId);
  if (stashed !== undefined && isAuthorizationSignal(stashed)) return stashed;
  return isAuthorizationSignal(toolResult.output) ? toolResult.output : undefined;
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

import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import { contextStorage } from "#context/container.js";
import {
  type AuthorizationSignal,
  isAuthorizationSignal,
  isPendingAuthorizationToolOutput,
  resolveActiveAuthorizationChallenges,
} from "#harness/authorization.js";
import { isPendingRemoteInputToolOutput } from "#harness/remote-input.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";

/** Returns whether an inline tool result represents a pending authorization interrupt. */
export function isInlineAuthorizationToolResult(toolResult: TypedToolResult<ToolSet>): boolean {
  return (
    isPendingAuthorizationToolOutput(toolResult.output) ||
    readAuthorizationSignal(toolResult) !== undefined
  );
}

/**
 * Which park an inline tool result belongs to, if any. Parked results go to
 * their park handler (the authorization detector, or remote input parking in
 * the step handler) instead of `action.result`.
 */
export function parkedToolResult(
  toolResult: TypedToolResult<ToolSet>,
): "authorization" | "remote-input" | undefined {
  if (isInlineAuthorizationToolResult(toolResult)) return "authorization";
  return isPendingRemoteInputToolOutput(toolResult.output) ? "remote-input" : undefined;
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
      readonly history: ModelMessage[];
    }
  | undefined {
  const signals: AuthorizationSignal[] = [];
  const interruptedCallIds = new Set<string>();

  for (const toolResult of input.toolResults ?? []) {
    const signal = readAuthorizationSignal(toolResult);
    if (signal === undefined) continue;
    signals.push(signal);
    interruptedCallIds.add(toolResult.toolCallId);
  }

  if (signals.length === 0) return undefined;

  return {
    challenges: resolveActiveAuthorizationChallenges(
      signals.flatMap((signal) => signal.challenges),
    ),
    history: projectCompletedSiblingCalls(input.messages, interruptedCallIds),
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

function projectCompletedSiblingCalls(
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

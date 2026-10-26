import type { ToolSet, TypedToolResult } from "ai";

import { contextStorage } from "#context/container.js";
import {
  type AuthorizationSignal,
  isAuthorizationSignal,
  isPendingAuthorizationToolOutput,
} from "#harness/authorization.js";
import { resolveActiveAuthorizationChallenges } from "#harness/hitl/sign-ins.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";
import type { RuntimeToolCallActionRequest } from "#shared/action-types.js";

/** Returns whether an inline tool result represents a pending authorization interrupt. */
export function isInlineAuthorizationToolResult(toolResult: TypedToolResult<ToolSet>): boolean {
  return (
    isPendingAuthorizationToolOutput(toolResult.output) ||
    readAuthorizationSignal(toolResult) !== undefined
  );
}

/** A call a sign-in stopped, as the entry it ran, and the connections it needs. */
export interface StoppedCall {
  readonly action: RuntimeToolCallActionRequest;
  readonly connections: readonly string[];
}

/** Resolves the authorization interrupts of a run's tool results. */
export function resolveInlineAuthorizationInterrupt(input: {
  readonly toolResults: readonly TypedToolResult<ToolSet>[] | undefined;
}):
  | {
      readonly challenges: AuthorizationSignal["challenges"];
      /** The calls sign-ins stopped, each with the connections it needs. */
      readonly calls: readonly StoppedCall[];
    }
  | undefined {
  const signals: AuthorizationSignal[] = [];
  const calls: StoppedCall[] = [];

  for (const toolResult of input.toolResults ?? []) {
    const signal = readAuthorizationSignal(toolResult);
    if (signal === undefined) continue;
    signals.push(signal);
    calls.push({
      action: createRuntimeToolCallActionFromToolCall({ toolCall: toolResult }),
      connections: signal.challenges.map((challenge) => challenge.name),
    });
  }

  if (signals.length === 0) return undefined;

  return {
    calls,
    challenges: resolveActiveAuthorizationChallenges(
      signals.flatMap((signal) => signal.challenges),
    ),
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

import type { ToolSet, TypedToolResult } from "ai";
import { contextStorage } from "#context/container.js";
import { isAuthorizationSignal, isPendingAuthorizationToolOutput } from "#harness/authorization.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";

/** Returns whether an inline tool result represents a pending authorization interrupt. */
export function isInlineAuthorizationToolResult(toolResult: TypedToolResult<ToolSet>): boolean {
  if (isPendingAuthorizationToolOutput(toolResult.output)) {
    return true;
  }
  const ctx = contextStorage.getStore();
  if (ctx === undefined) {
    return false;
  }
  const stashed = readToolInterrupt(ctx, toolResult.toolCallId);
  return stashed !== undefined && isAuthorizationSignal(stashed);
}

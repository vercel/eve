import type { PublicToolDefinition } from "#tools/definition.js";
import { attachToolBehavior, type CompiledToolBehavior } from "#tools/behavior.js";

/** Framework-only tool definition whose implementation is owned outside an executor. */
export type NativeToolDefinition<TInput = unknown, TOutput = unknown> = PublicToolDefinition<
  TInput,
  TOutput
>;

/** Defines an execute-less framework tool with closed internal behavior. */
export function defineNativeTool<TInput = unknown, TOutput = unknown>(
  definition: NativeToolDefinition<TInput, TOutput>,
  behavior: CompiledToolBehavior,
): NativeToolDefinition<TInput, TOutput> {
  return attachToolBehavior(definition, behavior);
}

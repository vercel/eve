import type { WorkflowToolContext } from "eve/tools";
import type { z } from "zod";

/**
 * Run one turn in a fresh session of a declared subagent and return its structured result.
 *
 * @remarks
 * The shared body of every workflow tool that fronts a subagent (`research` and
 * `review_draft`). eve takes structured output per turn, so the schema is
 * passed to `send` as the turn's `outputSchema`. Each call opens a session that ends when the
 * tool call finishes, so the subagent sees only `message`. Call it from a `"use workflow"` body:
 * `ctx.agent()` isn't available inside a `"use step"` helper.
 *
 * @param ctx - The workflow tool context; supplies `agent()` and the call's `abortSignal`.
 * @param name - The subagent's id, which is its directory name under `agent/subagents/`.
 * @param message - Everything the subagent needs; it inherits nothing from the caller.
 * @param outputSchema - Schema the subagent's reply must satisfy.
 * @returns The subagent's validated structured result.
 * @throws When the subagent's turn fails, or ends (for example, cancelled) without a result.
 */
export const askSubagent = async <TSchema extends z.ZodType>(
  ctx: Pick<WorkflowToolContext, "abortSignal" | "agent">,
  name: string,
  message: string,
  outputSchema: TSchema
): Promise<z.infer<TSchema>> => {
  const response = await ctx
    .agent(name)
    .send<z.infer<TSchema>>(message, { outputSchema, signal: ctx.abortSignal });
  const result = await response.result();
  if (result.status === "failed") {
    throw new Error(`The ${name} failed: ${result.error.message}`);
  }
  if (result.data === undefined) {
    throw new Error(`The ${name} stopped before returning a result.`);
  }
  return result.data;
};

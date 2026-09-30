import type { WorkflowToolContext } from "eve/tools";

/** Sends one message to a new session with `name` and returns its reply. */
export async function replyFrom(
  ctx: WorkflowToolContext,
  name: string,
  message: string,
): Promise<string | null> {
  const response = await ctx.agent(name).send(message);
  const result = await response.result();
  if (result.status === "failed") throw new Error(`Agent "${name}" failed.`);
  return result.message ?? null;
}

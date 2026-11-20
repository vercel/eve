import type { ContextReader } from "#context/key.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";
import type { Definition } from "./definition.js";

export async function sessionDefinitions(
  ctx: Pick<ContextReader, "get">,
): Promise<readonly Definition[]> {
  return await sessionAgent(ctx).definitions();
}

export function sessionAgent(ctx: Pick<ContextReader, "get">): SessionAgent {
  const agent = ctx.get(SessionAgentKey);
  if (agent === undefined) throw new Error("The session has no agent in its context.");
  return agent;
}

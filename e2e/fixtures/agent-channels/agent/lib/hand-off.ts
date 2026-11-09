import type { WorkflowStepToolContext, WorkflowToolContext } from "eve/tools";

import target from "../channels/target";

export async function handOff({ sessionRef }: { sessionRef: string }, ctx: WorkflowToolContext) {
  "use workflow";
  return await send(ctx, sessionRef);
}

async function send(ctx: WorkflowStepToolContext, sessionRef: string) {
  "use step";
  const delivery = await ctx.to(target, { sessionRef }).send("Bob's request, handed off.", {
    auth: ctx.session.auth.current,
    idempotencyKey: `${ctx.session.id}:${ctx.callId}:hand-off`,
  });
  return { sessionId: delivery.sessionId };
}

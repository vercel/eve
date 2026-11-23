import { isScheduleAuth } from "eve/schedules";
import type { ToolContext } from "eve/tools";
import type { Config } from "./config.js";
import { store, type Storage } from "./store.js";

export async function authorizeCoordinator(
  c: Config,
  ctx: Pick<ToolContext, "session">,
  db: Storage = store(c),
) {
  const active = await db.active();
  if (
    !isScheduleAuth(ctx.session.auth.current) ||
    !ctx.session.parent ||
    !active?.experiment ||
    active.experiment.rootSession !== ctx.session.parent.rootSessionId ||
    active.experiment.rootSession !== ctx.session.parent.sessionId ||
    active.lease.until <= Date.now()
  )
    throw new Error("No active authorized scheduled delegation");
  const experiment = await db.bindSession(active.lease, "coordinatorSession", ctx.session.id);
  return { lease: active.lease, experiment };
}

export async function authorizeAnalyst(
  c: Config,
  ctx: Pick<ToolContext, "session">,
  db: Storage = store(c),
) {
  const active = await db.active();
  if (
    !isScheduleAuth(ctx.session.auth.current) ||
    !ctx.session.parent ||
    !active?.experiment ||
    active.experiment.rootSession !== ctx.session.parent.rootSessionId ||
    active.experiment.coordinatorSession !== ctx.session.parent.sessionId ||
    active.lease.until <= Date.now()
  )
    throw new Error("No authorized analyst delegation");
}

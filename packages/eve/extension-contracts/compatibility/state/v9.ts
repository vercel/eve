// Existing callbacks remain valid when the runtime supplies session.context.
import { defineState, type SessionContext } from "#public/context/index.js";
export const visits = defineState("compatibility.visits", () => ({ count: 0 }));
export function recordVisit(ctx: SessionContext): string {
  visits.update((current) => ({ count: current.count + 1 }));
  return `${ctx.session.id}: ${visits.get().count}`;
}

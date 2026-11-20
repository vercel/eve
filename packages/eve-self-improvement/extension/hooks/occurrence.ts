import { defineHook } from "eve/hooks";
import { call } from "eve/events";
import { isScheduleAuth } from "eve/schedules";
import extension from "../extension.js";
import { store } from "../lib/store.js";

export default defineHook({
  events: {
    async "call.settled"(event, ctx) {
      if (!isScheduleAuth(ctx.session.auth.current) || !ctx.session.schedule) return;
      const observed = call(ctx.view, event.data.callId);
      const expected = ctx.session.schedule.definition.replace(/daily$/, "cycle");
      if (observed?.kind !== "tool" || observed.name !== expected) return;
      if (
        observed.output &&
        typeof observed.output === "object" &&
        "status" in observed.output &&
        observed.output.status === "delegated"
      )
        return;
      const db = store(extension.config);
      const occurrence = await db.get<{ session: string; analysisId: string }>("occurrence:last");
      if (occurrence?.session !== ctx.session.id) return;
      const decision = await db.get<{ status: string }>(occurrence.analysisId);
      if (!decision) return;
      await db.put("occurrence:last", {
        ...occurrence,
        settled:
          event.data.outcome === "completed" &&
          !["interrupted", "setup-blocked"].includes(decision!.status),
        outcome: event.data.outcome,
        status: decision!.status,
        at: ctx.now.toISOString(),
      });
    },
  },
});

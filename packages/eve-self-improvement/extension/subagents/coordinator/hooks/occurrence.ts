import { defineHook } from "eve/hooks";
import { call } from "eve/events";
import { isScheduleAuth } from "eve/schedules";
import extension from "../../../extension.js";
import { store } from "../../../lib/store.js";

export default defineHook({
  events: {
    async "call.settled"(event, ctx) {
      if (
        !isScheduleAuth(ctx.session.auth.current) ||
        !ctx.session.parent ||
        event.data.outcome !== "completed"
      )
        return;
      const observed = call(ctx.view, event.data.callId);
      if (
        observed?.name !== "step" ||
        !observed.input ||
        typeof observed.input !== "object" ||
        !("action" in observed.input) ||
        observed.input.action !== "finish"
      )
        return;
      const db = store(extension.config);
      const occurrence = await db.get<{ session: string; analysisId: string }>("occurrence:last");
      if (occurrence?.session !== ctx.session.parent.rootSessionId) return;
      const report = await db.get<{ status: string }>(occurrence.analysisId);
      if (!report) return;
      await db.put("occurrence:last", {
        ...occurrence,
        settled: !["interrupted", "setup-blocked", "analyzing"].includes(report.status),
        outcome: "completed",
        status: report.status,
        at: ctx.now.toISOString(),
      });
    },
  },
});

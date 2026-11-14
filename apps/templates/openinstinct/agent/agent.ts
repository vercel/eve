import { defineAgent, defineDynamic } from "eve";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import { getGatewayModel } from "@db/services/settings";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

export default defineAgent({
  build: {
    // The browser-agent subagent's Browser Loop tools load this at runtime.
    externalDependencies: ["@onkernel/browser-loop"],
  },
  defaultTools: false,
  // eve resolves this before every model call, so the lease is rechecked per step.
  model: defineDynamic(async (ctx) => {
    const scheduledRun = scheduledRunIdentity(ctx.session.auth);
    if (
      scheduledRun &&
      !(await isScheduledAgentRunLeaseActive(
        scheduledRun.runId,
        scheduledRun.leaseToken
      ))
    ) {
      throw new Error("The scheduled run lease is no longer active.");
    }
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    if (!caller) throw new Error("An authenticated user is required.");
    return getGatewayModel(scopeFromPrincipal(caller));
  }),
  reasoning: "low",
  compaction: {
    threshold: 0.7,
  },
});

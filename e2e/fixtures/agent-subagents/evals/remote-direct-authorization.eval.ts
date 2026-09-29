import { defineEval } from "eve/evals";
import { DIRECT_AUTHORIZATION } from "../agent/lib/remote-direct-hitl-script.js";

export default defineEval({
  description: "Alice authorizes a tool called directly in her remote agent.",
  timeoutMs: 90_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      `${DIRECT_AUTHORIZATION}: Alice asks her remote agent to authorize the release checklist.`,
    );
    const required = await live.waitForEvent("authorization.required");
    if (required.data.webhookUrl === undefined)
      throw new Error("Direct remote authorization has no callback URL.");
    const callback = new URL(required.data.webhookUrl);
    callback.searchParams.set("code", "direct-release-code");
    const response = await t.target.fetch(`${callback.pathname}${callback.search}`);
    if (!response.ok) throw new Error(`Direct authorization callback returned ${response.status}.`);
    const turn = await live.result();
    turn.expectOk();
    turn.event("authorization.required", {
      data: {
        name: "direct-release-authorization",
        authorization: { userCode: "direct-release-code" },
      },
    });
    turn.event("authorization.completed", {
      data: { name: "direct-release-authorization", outcome: "authorized" },
    });
    turn.messageIncludes("PARENT-DIRECT-COMPLETE: DIRECT-AUTHORIZATION-COMPLETE");
    t.calledSubagent("remote-loopback", { status: "completed", count: 1 });
    t.noFailedActions();
  },
});

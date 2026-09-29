import { defineEval } from "eve/evals";
import { NESTED_AUTHORIZATION } from "../agent/lib/remote-nested-script.js";

const AUTHORIZATION_CODE = "nested-release-code";
const AUTHORIZATION_NAME = "nested-release-authorization";

export default defineEval({
  description:
    "Alice completes a nested worker's authorization callback through the remote parent.",
  timeoutMs: 120_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      `${NESTED_AUTHORIZATION}: Alice asks the remote agent to authorize her release checklist.`,
    );
    const required = await live.waitForEvent("authorization.required");
    if (required.data.webhookUrl === undefined) {
      throw new Error("Nested authorization challenge has no callback URL.");
    }
    const callback = new URL(required.data.webhookUrl);
    callback.searchParams.set("code", AUTHORIZATION_CODE);
    const response = await fetch(callback);
    if (!response.ok) throw new Error(`Nested authorization callback returned ${response.status}.`);

    const turn = await live.result();
    turn.expectOk();
    turn.event("authorization.required", {
      data: { name: AUTHORIZATION_NAME, authorization: { userCode: AUTHORIZATION_CODE } },
    });
    turn.event("authorization.completed", {
      data: { name: AUTHORIZATION_NAME, outcome: "authorized" },
    });
    if (!turn.message?.includes("PARENT-NESTED-COMPLETE: CHILD-NESTED-AUTHORIZATION-COMPLETE")) {
      throw new Error("Nested authorization result did not reach the parent.");
    }
    t.noFailedActions();
  },
});

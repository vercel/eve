import { defineEval } from "eve/evals";

import {
  ALICE,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  as,
  asAlice,
  expectNotRun,
  expectResolved,
} from "../helpers.ts";

/**
 * Alice approves the frozen change after a change freeze started. Her
 * approval stands, but eve checks the tool's policy again right before the
 * call runs, and the freeze denies it: the change never runs.
 */
export default defineEval({
  description: "An approved call whose policy now denies it does not run.",
  tags: ["hitl", "human-input", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.frozen, asAlice), "frozen-change");

    const frozen = (
      await session.respond(answers("approve", request), as(ALICE, "freeze"))
    ).expectOk();
    expectResolved(frozen, request, "approved");
    expectNotRun(frozen, "frozen-change");
    frozen.event("action.result", {
      count: 1,
      data: {
        status: "rejected",
        result: {
          output: { code: "TOOL_EXECUTION_DENIED", message: "A change freeze is in effect." },
          toolName: "frozen-change",
        },
      },
    });
    frozen.event("message.completed", { data: { message: "Frozen change: not run." } });
  },
});

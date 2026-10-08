import { defineEval } from "eve/evals";

import {
  ALICE,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  as,
  asBob,
  expectNotRun,
  expectResolved,
} from "../helpers.ts";

/**
 * Bob approves Alice's change as a freeze begins for Alice only. His
 * approval stands, but eve checks the tool's policy again right before the
 * call runs, and the freeze denies it: the change never runs.
 */
export default defineEval({
  description: "An approved call whose policy now denies it does not run.",
  tags: ["hitl", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(
      await session.send(SAY.frozen, as(ALICE, "freeze")),
      "frozen-change",
    );

    const frozen = (await session.respond(answers("approve", request), asBob)).expectOk();
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

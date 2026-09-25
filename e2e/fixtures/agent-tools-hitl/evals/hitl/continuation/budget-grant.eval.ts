import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import {
  scriptedSession,
  expectChangeStillUnexecuted,
  expectToolResult,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description: "After a budget grant, an older approval cannot swallow the next budget request.",
  tags: ["hitl", "continuation", "regression", "input-response", "budget"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A awaits approval and a requested read is blocked on the exhausted session budget.
    const first = await t.send("Prepare change A using the remaining budget.", scriptedSession);
    requestFrom(first, "change-a");
    const session = first.session;
    const limited = await session.send("Read the draft status using the remaining budget.");
    const budget = requestFrom(limited, "session_limit_continuation");

    // When the user grants another budget window.
    const live = await session.startRespond([
      { requestId: budget.requestId, optionId: "continue" },
    ]);

    // Then the read executes and a new budget request appears; A stays unexecuted.
    await expectToolResult(t, live, "read-draft");
    const next = (await live.result()).expectOk();
    const nextBudget = requestFrom(next, "session_limit_continuation");
    await t.check(nextBudget.requestId === budget.requestId, equals(false));
    next.calledTool("read-draft", { status: "completed", count: 1 });
    next.notEvent("message.completed");
    expectChangeStillUnexecuted(session);
    await session.respond([{ requestId: nextBudget.requestId, optionId: "stop" }]);
  },
});

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
    const budget = requestFrom(limited, "budget");

    // When the user grants another budget window.
    const live = await session.startRespond([
      { interactionId: budget.interactionId, optionId: "approve" },
    ]);

    // Then the read executes and a new budget request appears; A stays unexecuted.
    await expectToolResult(t, live, "read-draft");
    const next = (await live.result()).expectOk();
    const nextBudget = requestFrom(next, "budget");
    await t.check(nextBudget.interactionId === budget.interactionId, equals(false));
    next.calledTool("read-draft", { status: "completed", count: 1 });
    next.notEvent("content.completed", { data: { kind: "text", phase: "reply" } });
    expectChangeStillUnexecuted(session);
    await session.respond([{ interactionId: nextBudget.interactionId, optionId: "deny" }]);
  },
});

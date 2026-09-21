import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { scriptedSession, expectToolResult, requestFrom } from "./helpers.ts";

export default defineEval({
  description: "Control: a renewed budget runs one tool, then asks for the next grant.",
  tags: ["hitl", "continuation", "control", "input-response", "budget"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a requested read is blocked on the exhausted session budget with no older approval.
    const first = await t.send("Use the remaining budget to say hello.", scriptedSession);
    const session = first.session;
    const limited = await session.send("Read the draft status using the remaining budget.");
    const budget = requestFrom(limited, "session_limit_continuation");

    // When the user grants another budget window.
    const live = await session.startRespond([
      { requestId: budget.requestId, optionId: "continue" },
    ]);

    // Then the read executes and a new budget request appears before any final reply.
    await expectToolResult(t, live, "read-draft");
    const next = (await live.result()).expectOk();
    const nextBudget = requestFrom(next, "session_limit_continuation");
    await t.check(nextBudget.requestId === budget.requestId, equals(false));
    next.calledTool("read-draft", { status: "completed", count: 1 });
    next.notEvent("message.completed");
    await session.respond([{ requestId: nextBudget.requestId, optionId: "stop" }]);
  },
});

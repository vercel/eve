import type { EveEvalContext, EveEvalSession } from "eve/evals";
import { equals } from "eve/evals/expect";

export async function checkInputHookDelivery(
  t: EveEvalContext,
  session: EveEvalSession,
  requestId: string,
): Promise<void> {
  const audit = await session.send("Call read-input-hooks exactly once. INPUT-HOOKS:AUDIT");
  audit.expectOk();
  audit.calledTool("read-input-hooks", { count: 1, status: "completed" });
  const observations = audit.toolCalls.find((call) => call.name === "read-input-hooks")?.output;
  t.check(
    observations,
    equals(
      ["channel", "hook"].map((receiver) => ({
        receiver,
        sessionId: session.sessionId,
        requestIds: [requestId],
      })),
    ),
  ).label("the parent channel and hook receive the same request exactly once, in order");
}

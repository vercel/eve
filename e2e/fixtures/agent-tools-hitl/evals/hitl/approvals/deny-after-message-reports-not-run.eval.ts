import { defineEval } from "eve/evals";

import {
  REPLY,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  expectNotRun,
  expectResolved,
  expectWaitsAsTask,
  taskResultsReply,
} from "../helpers.ts";

/**
 * Alice asks for change A, then asks for a hello while its approval waits. A's call waits as a
 * task. When she denies it, the call doesn't run, and the model reads a failed task result.
 */
export default defineEval({
  description: "Denying an approval after a message reports a failed task result.",
  tags: ["hitl", "approval", "steer"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.changeA, asAlice), "change-a");

    const joined = (await session.send(SAY.hello, asAlice)).expectOk();
    expectWaitsAsTask(joined, request);
    joined.event("content.completed", { data: { phase: "reply", value: REPLY.hello } });

    const denied = (await session.respond(answers("deny", request), asAlice)).expectOk();
    expectResolved(denied, request, "declined");
    expectNotRun(denied, "change-a");
    denied.event("content.completed", {
      data: { phase: "reply", value: taskResultsReply([["change-a", "failed"]]) },
    });
    denied.event("turn.settled", { count: 1, data: { outcome: "completed" } });
  },
});

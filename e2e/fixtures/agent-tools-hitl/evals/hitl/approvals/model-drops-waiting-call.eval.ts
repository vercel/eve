import { defineEval } from "eve/evals";

import {
  REPLY,
  SAY,
  aliceSession,
  approvalFor,
  asAlice,
  expectNotRun,
  expectResolved,
  expectWaitsAsTask,
} from "../helpers.ts";

/**
 * Alice asks for changes A and B, then says B is no longer needed while both approvals wait. Both
 * calls wait as tasks, and the model drops B with `eve__task_cancel`: B's approval is withdrawn
 * and its call never runs, while A's approval stays open.
 */
export default defineEval({
  description: "The model drops a call that waits on a person with eve__task_cancel.",
  tags: ["hitl", "approval", "steer", "tasks"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.changesAB, asAlice);
    const a = approvalFor(asked, "change-a");
    const b = approvalFor(asked, "change-b");

    const dropped = (await session.send(SAY.dropB, asAlice)).expectOk();
    dropped.calledTool("eve__task_cancel", { status: "completed", count: 1 });
    expectResolved(dropped, b, "withdrawn");
    expectNotRun(dropped, "change-b");
    expectWaitsAsTask(dropped, a);
    dropped.event("content.completed", { data: { phase: "reply", value: REPLY.droppedB } });
  },
});

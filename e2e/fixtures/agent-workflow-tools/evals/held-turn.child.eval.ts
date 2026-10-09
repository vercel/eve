import { defineEval } from "eve/evals";

import { STAGER_INTERIM_MESSAGE } from "../task-scenario-text";

const CHILD_REPLY = /^WORKFLOW-CHILD-STAGED /u;

/**
 * The root delegates to `workflow-stager`, whose own turn holds on a staging
 * task after writing text. The child's turn pauses as any held turn does, but
 * its held text is narration, so the parent's task receives only the child's
 * final reply.
 */
export default defineEval({
  description: "A child session's held turn narrates its held text and returns only its final reply.",
  async test(t) {
    const parent = await t.send("WORKFLOW-DELEGATE-STAGE");
    parent.expectOk();
    const started = parent.events.find(
      (event) => event.type === "child.opened" && event.data.name === "workflow-stager",
    );
    if (started?.type !== "child.opened") throw new Error("workflow-stager never started.");

    const child = await t.target.watchTurn(started.data.sessionId).result();
    child.expectOk();
    child.event("content.completed", {
      count: 1,
      data: { kind: "text", phase: "narration", value: STAGER_INTERIM_MESSAGE },
    });
    child.event("content.completed", {
      count: 1,
      data: { kind: "text", phase: "reply", value: CHILD_REPLY },
    });
    child.event("turn.paused", { count: 1 });
    child.event("turn.settled", { count: 1, data: { outcome: "completed" } });

    parent.event("call.settled", {
      count: 1,
      data: { callId: "delegate", outcome: "completed", output: CHILD_REPLY },
    });
    parent.messageIncludes("WORKFLOW-DELEGATE-RESULT WORKFLOW-CHILD-STAGED");
    t.noFailedActions();
  },
});

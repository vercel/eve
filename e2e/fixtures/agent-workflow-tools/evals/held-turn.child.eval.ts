import { defineEval } from "eve/evals";

import { STAGER_INTERIM_MESSAGE } from "../task-scenario-text";
import { HELD_TURN } from "./held-turn.shared";

const CHILD_REPLY = /^WORKFLOW-CHILD-STAGED /u;

/**
 * The root delegates to `workflow-stager`, whose own turn holds on a staging
 * task after writing text. A child session shows no waiting boundary: the held
 * text step reports `"tool-calls"`, and the parent's task receives only the
 * child's final reply.
 */
export default defineEval({
  description: "A child session's held turn reports tool-calls and returns only its final reply.",
  async test(t) {
    const parent = await t.send("WORKFLOW-DELEGATE-STAGE");
    parent.expectOk();
    const started = parent.events.find(
      (event) => event.type === "agent.started" && event.data.name === "workflow-stager",
    );
    if (started?.type !== "agent.started") throw new Error("workflow-stager never started.");

    const child = await t.target.watchTurn(started.data.sessionId).result();
    child.expectOk();
    child.event("message.completed", {
      count: 1,
      data: { finishReason: "tool-calls", message: STAGER_INTERIM_MESSAGE },
    });
    child.event("message.completed", {
      count: 1,
      data: { finishReason: "stop", message: CHILD_REPLY },
    });
    child.notEvent("session.waiting", { data: HELD_TURN });
    child.event("turn.completed", { count: 1 });

    parent.event("task.settled", {
      count: 1,
      data: { callId: "delegate", output: CHILD_REPLY, status: "completed" },
    });
    parent.messageIncludes("WORKFLOW-DELEGATE-RESULT WORKFLOW-CHILD-STAGED");
    t.noFailedActions();
  },
});

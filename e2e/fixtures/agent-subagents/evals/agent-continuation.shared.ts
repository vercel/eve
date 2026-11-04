import type { EveEvalContext, EveEvalTurn } from "eve/evals";

import { NOTEBOOK_NAME } from "../constants";
import { callsReachingTasks } from "./task-calls.shared";

/**
 * Alice checks the keeper's memory while its task is idle, interrupts its next
 * review, then supplies the name again to a new keeper task before recalling it.
 */
export async function continueKeeperAcrossTurns(t: EveEvalContext, tool: string): Promise<void> {
  const remembered = await t.send(`NOTEBOOK-REMEMBER ${tool} Alice shares the notebook name.`);
  remembered.expectOk();
  remembered.messageIncludes("NOTEBOOK-REPLY NOTEBOOK-SAVED");
  const firstChildId = requireChildSession(remembered, tool);
  const firstChildTurn = await t.target.attach(firstChildId).watch().result();

  const checked = await remembered.session.send(
    `NOTEBOOK-CHECK ${tool} Alice checks the name with the same keeper while it is idle.`,
  );
  checked.expectOk();
  checked.event("call.settled", {
    count: 1,
    data: {
      callId: "notebook-idle-recall",
      output: `NOTEBOOK-NAME=${NOTEBOOK_NAME}`,
      outcome: "completed",
    },
  });
  checked.messageIncludes(`NOTEBOOK-REPLY NOTEBOOK-NAME=${NOTEBOOK_NAME}`);

  const reviewed = await checked.session.send(
    `NOTEBOOK-REVIEW ${tool} Alice asks for a review, then changes her mind.`,
  );
  reviewed.expectOk();
  reviewed.calledTool("eve__task_cancel", {
    count: 1,
    output: /^Stopped \S+; it won't report back\./u,
  });
  reviewed.event("call.settled", {
    count: 1,
    data: { callId: "notebook-review", outcome: "interrupted" },
  });
  reviewed.event("task.ended", { count: 1, data: { outcome: "cancelled" } });
  const retiredChild = await t.target
    .attach(firstChildId, { startIndex: firstChildTurn.session.state.streamIndex })
    .watch({ until: (event) => event.type === "session.ended" })
    .result();
  retiredChild.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
  retiredChild.event("session.ended", { count: 1, data: { outcome: "completed" } });

  const restarted = await reviewed.session.send(
    `NOTEBOOK-RESTART ${tool} Alice begins a new notebook conversation and shares the name again.`,
  );
  restarted.expectOk();
  restarted.messageIncludes("NOTEBOOK-REPLY NOTEBOOK-SAVED");
  const secondChildId = requireChildSession(restarted, tool);

  const recalled = await restarted.session.send(
    `NOTEBOOK-RECALL ${tool} Alice asks her new keeper for the name she just shared.`,
  );
  recalled.expectOk();
  recalled.event("call.settled", {
    count: 1,
    data: {
      callId: "notebook-recall",
      output: `NOTEBOOK-NAME=${NOTEBOOK_NAME}`,
      outcome: "completed",
    },
  });
  recalled.messageIncludes(`NOTEBOOK-REPLY NOTEBOOK-NAME=${NOTEBOOK_NAME}`);

  t.event("child.opened", { count: 2, data: { name: tool } });
  t.event("task.started", { count: 2, data: { name: tool, kind: "agent" } });
  t.eventsSatisfy(
    "idle continuation, cancellation, and reseeded replacement are separate tasks",
    (events) => {
      const calls = callsReachingTasks(events, tool);
      const byCall = new Map(calls.map((call) => [call.callId, call]));
      const first = byCall.get("notebook-remember")?.taskId;
      const second = byCall.get("notebook-restart")?.taskId;
      return (
        calls.length === 5 &&
        new Set(calls.map((call) => call.turnId)).size === 5 &&
        first !== undefined &&
        second !== undefined &&
        first !== second &&
        byCall.get("notebook-idle-recall")?.taskId === first &&
        byCall.get("notebook-review")?.taskId === first &&
        byCall.get("notebook-recall")?.taskId === second &&
        events.filter(
          (event) =>
            event.type === "task.ended" &&
            event.data.taskId === first &&
            event.data.outcome === "cancelled",
        ).length === 1
      );
    },
  );
  if (firstChildId === secondChildId)
    throw new Error("The replacement task reused the retired child.");
}

function requireChildSession(turn: EveEvalTurn, tool: string): string {
  const started = turn.events.find(
    (event) => event.type === "child.opened" && event.data.name === tool,
  );
  if (started?.type !== "child.opened") throw new Error(`${tool} never started a session.`);
  return started.data.sessionId;
}

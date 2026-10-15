import type { EveEvalContext, EveEvalTurn } from "eve/evals";

import { NOTEBOOK_NAME } from "../constants";
import { callsReachingTasks } from "./task-calls.shared";

/**
 * Drives the notebook script against one keeper agent over three parent
 * turns: remember a name, start a review on the same task and cancel it, then
 * ask the same task for the name. Every call must reach one task and one child
 * session, the cancel must end the child's review turn, and the name must
 * survive it.
 */
export async function continueKeeperAcrossTurns(t: EveEvalContext, tool: string): Promise<void> {
  const remembered = await t.send(`NOTEBOOK-REMEMBER ${tool} Alice shares the notebook name.`);
  remembered.expectOk();
  remembered.messageIncludes("NOTEBOOK-REPLY NOTEBOOK-SAVED");
  const childSessionId = requireChildSession(remembered, tool);
  const firstChildTurn = await t.target.watchTurn(childSessionId).result();

  const reviewed = await remembered.session.send(
    `NOTEBOOK-REVIEW ${tool} Alice asks for a review, then changes her mind.`,
  );
  reviewed.expectOk();
  reviewed.calledTool("eve__task_cancel", { count: 1, output: /^Stopped \S+'s current work;/u });
  reviewed.event("call.settled", {
    count: 1,
    data: { callId: "notebook-review", outcome: "interrupted" },
  });
  const cancelledChildTurn = await t.target
    .watchTurn(childSessionId, { startIndex: firstChildTurn.session.state.streamIndex })
    .result();
  cancelledChildTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });

  const recalled = await reviewed.session.send(`NOTEBOOK-RECALL ${tool} Alice asks for the name.`);
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

  t.event("child.opened", { count: 1, data: { name: tool } });
  t.eventsSatisfy("each turn's call reaches the one task the first call started", (events) => {
    const calls = callsReachingTasks(events, tool);
    return (
      calls.length === 3 &&
      new Set(calls.map((call) => call.taskId)).size === 1 &&
      new Set(calls.map((call) => call.turnId)).size === 3
    );
  });
}

function requireChildSession(turn: EveEvalTurn, tool: string): string {
  const started = turn.events.find(
    (event) => event.type === "child.opened" && event.data.name === tool,
  );
  if (started?.type !== "child.opened") throw new Error(`${tool} never started a session.`);
  return started.data.sessionId;
}

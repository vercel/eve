import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "A background workflow tool returns a receipt, reports progress, and wakes the agent with its result.",
  async test(t) {
    const started = await t.send("WORKFLOW-REPORT-START");
    const conversation = started.session;
    started.expectOk();
    started.calledTool("report_deploy");

    const receipt = started.requireToolCall("report_deploy");
    const taskId = readTaskId(receipt.output);
    if (taskId === undefined) throw new Error("report_deploy receipt is missing taskId.");

    const sessionId = conversation.sessionId;
    if (sessionId === undefined) throw new Error("Eval has no parent session id.");

    const doneLive = t.target.watchTurn(sessionId, {
      startIndex: requireStreamIndex(started.session, "completion wait"),
    });
    const doneTurn = await doneLive.result();
    doneTurn.expectOk();
    doneTurn.messageIncludes("WORKFLOW-REPORT-DONE");
    await t.require(
      doneTurn.events,
      satisfies(
        (events: typeof doneTurn.events) =>
          events.some(
            (event) =>
              event.type === "message.received" &&
              messageText(event.data.message).includes(
                `Background task ${taskId} (report_deploy) is completed.`,
              ) &&
              messageText(event.data.message).includes("WORKFLOW-REPORT-COMPLETE"),
          ),
        "parent receives the run's return value with task identity",
      ),
    );
    doneTurn.event("turn.started", { count: 1 });
    doneTurn.notEvent("message.received", {
      data: (data) => messageText(data.message).includes("PROGRESS"),
    });
    t.noFailedActions();
  },
});

function readTaskId(output: unknown): string | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const taskId = Reflect.get(output, "taskId");
  return typeof taskId === "string" ? taskId : undefined;
}

function requireStreamIndex(
  session: { readonly state?: { readonly streamIndex?: number } },
  operation: string,
): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error(`${operation} has no session stream index.`);
  return streamIndex;
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  return JSON.stringify(message);
}

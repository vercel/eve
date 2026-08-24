import { defineEval, type EveEvalTurn } from "eve/evals";

const SETUP = "CANONICAL-SOURCE-GRAPH-TASK-SETUP";
const UPDATE = "CANONICAL-SOURCE-GRAPH-TASK-UPDATE";

export default defineEval({
  description:
    "A named background-task subagent receives task_update and delivers its update to the parent.",
  async test(t) {
    const started = await t.send(SETUP);
    started.expectOk();
    started.messageIncludes("CANONICAL-SOURCE-GRAPH-TASK-STARTED");

    const taskId = requireBackgroundTaskId(started);
    const sessionId = t.sessionId;
    const state = t.state;
    if (sessionId === undefined || state === undefined) {
      throw new Error("Named task update eval has no parent session state.");
    }

    const update = await t.target.watchTurn(sessionId, { startIndex: state.streamIndex }).result();
    update.expectOk();
    update.messageIncludes("CANONICAL-SOURCE-GRAPH-TASK-UPDATE-RECEIVED");

    const notifications = update.events.filter(
      (event) =>
        event.type === "message.received" &&
        messageText(event.data.message).includes(
          `Background task ${taskId} (task-reporter) update: ${UPDATE}`,
        ),
    );
    if (notifications.length !== 1) {
      throw new Error(
        `Expected exactly one named task update notification; received ${notifications.length}.`,
      );
    }
    update.notEvent("subagent.completed");
    t.noFailedActions();
  },
});

function requireBackgroundTaskId(turn: EveEvalTurn): string {
  const receipts = turn.events.flatMap((event) =>
    event.type === "subagent.completed" && event.data.backgroundTask !== undefined
      ? [event.data.backgroundTask.taskId]
      : [],
  );
  if (receipts.length !== 1) {
    throw new Error(`Expected one background task receipt; received ${receipts.length}.`);
  }
  return receipts[0]!;
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .flatMap((part) =>
      part !== null &&
      typeof part === "object" &&
      Reflect.get(part, "type") === "text" &&
      typeof Reflect.get(part, "text") === "string"
        ? [Reflect.get(part, "text") as string]
        : [],
    )
    .join("\n");
}

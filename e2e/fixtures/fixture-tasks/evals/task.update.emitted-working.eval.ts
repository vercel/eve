import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";
import { requireBackgroundTaskId, requireSessionStreamIndex } from "./shared.js";

const UPDATE = "TASK-UPDATE-PROGRESS";

export default defineTaskEval({
  description: "A running child sends one intermediate update to its parent through task_update.",
  transition: {
    primary: "task.update.emitted-working",
    setup: ["task.dispatch.start.accepted-acknowledged"],
    dimensions: { transport: "local", parentPhase: "parked" },
  },
  async test(t) {
    const started = await t.send("TASK-UPDATE-SETUP");
    started.expectOk();
    started.messageIncludes("TASK-UPDATE-STARTED");
    const taskId = requireBackgroundTaskId(started);

    const sessionId = t.sessionId;
    if (sessionId === undefined) throw new Error("Task update eval has no parent session id.");
    const live = t.target.watchTurn(sessionId, {
      startIndex: requireSessionStreamIndex(t, "Task update wait"),
    });
    const updateTurn = await live.result();
    updateTurn.expectOk();
    updateTurn.messageIncludes("TASK-UPDATE-RECEIVED");
    await t.require(
      updateTurn.events,
      satisfies(
        (events: typeof updateTurn.events) =>
          events.some(
            (event) =>
              event.type === "message.received" &&
              messageText(event.data.message).includes(
                `Background task ${taskId} (update-worker) update: ${UPDATE}`,
              ),
          ),
        "parent receives the child update with its owning task identity",
      ),
    );
    updateTurn.notEvent("subagent.completed");
    t.noFailedActions();
  },
});

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

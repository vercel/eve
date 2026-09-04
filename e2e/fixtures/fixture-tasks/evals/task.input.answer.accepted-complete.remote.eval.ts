import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForCompletedTask,
  waitForTaskInput,
  waitForTaskNotification,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const REMOTE_PRINCIPAL_MARKER = "C8-REMOTE-PRINCIPAL:user:remote-http-child";

/**
 * Also covers the /eve/v1 callback-prefix regression (#3047): vercel.json
 * mounts this fixture at /eve/v1. Both the input request and completion must
 * reach the parent through its generated callback URL. A doubled /eve/v1 prefix
 * prevents these deliveries. The build scenario checks the prefix itself;
 * this eval checks the remote round trip through the public event stream.
 */
export default defineTaskEval({
  description:
    "A remote child delivers HITL and completion through /eve/v1/callback/* and resumes with its HTTP principal intact.",
  transition: {
    primary: "task.input.answer.accepted-complete",
    dimensions: { transport: "remote" },
  },
  async test(t) {
    const started = await t.send("TASK-C8-REMOTE-HITL");
    started.expectOk();
    started.messageIncludes("TASK-C8-STARTED");
    started.event("subagent.completed", {
      count: 1,
      data: {
        backgroundTask: { status: "working" },
        callId: "task-c8-remote-worker",
        subagentName: "remote-loopback",
      },
    });
    const taskId = requireBackgroundTaskId(started);

    t.event("input.requested", {
      count: 1,
      data: { requests: [{ action: { toolName: "remote_gate" } }] },
    }).label("remote input callback reaches the parent");
    t.log("Waiting for the remote input callback to reach the parent.");
    const gate = await waitForTaskInput(t, t, "remote_gate");
    const answered = await gate.session.respond([
      {
        optionId: "approve",
        requestId: gate.request.requestId,
      },
    ]);
    answered.expectOk();
    answered.eventsSatisfy(
      "a following parent model step belongs only to a task-ready notification",
      (events) =>
        !events.some((event) => event.type === "step.started") ||
        events.some(
          (event) =>
            event.type === "message.received" &&
            messageText(event.data.message).includes(`Background task ${taskId}`),
        ),
    );
    answered.noFailedActions();

    t.eventsSatisfy("remote completion callback reaches the parent", (events) =>
      events.some(
        (event) =>
          event.type === "message.received" &&
          messageText(event.data.message).includes(`Background task ${taskId}`) &&
          messageText(event.data.message).includes(REMOTE_PRINCIPAL_MARKER),
      ),
    );
    t.log("Waiting for the remote completion callback to reach the parent.");
    const completed = await waitForTaskNotification(t, gate.session, taskId, "completed", [
      answered,
    ]);
    completed.turn.expectOk();

    const terminal = await waitForCompletedTask(
      t,
      completed.session,
      "TASK-C8-REMOTE-VERIFY",
      taskId,
    );
    terminal.expectOk();
    const view = requireTaskView(terminal.requireToolCall("task_cancel").output, taskId);
    await t.require(
      view,
      satisfies(
        (task: Record<string, unknown>) =>
          Reflect.get(task, "status") === "completed" &&
          hasRemoteSubagentMetadata(task) &&
          hasRemotePrincipalOutput(task),
        "completed remote task retains subagent identity and the HTTP child principal",
      ),
    );

    t.notEvent("authorization.required");
    t.noFailedActions();
  },
});

function hasRemoteSubagentMetadata(task: Record<string, unknown>): boolean {
  const metadata = Reflect.get(task, "metadata");
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    Reflect.get(metadata, "kind") === "subagent" &&
    Reflect.get(metadata, "mode") === "remote" &&
    Reflect.get(metadata, "name") === "remote-loopback" &&
    typeof Reflect.get(metadata, "agentId") === "string"
  );
}

function hasRemotePrincipalOutput(task: Record<string, unknown>): boolean {
  const output = Reflect.get(task, "lastOutput");
  return (
    output !== null &&
    typeof output === "object" &&
    Reflect.get(output, "type") === "result" &&
    typeof Reflect.get(output, "data") === "string" &&
    Reflect.get(output, "data").includes(REMOTE_PRINCIPAL_MARKER)
  );
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

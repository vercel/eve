import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForCompletedTask,
  waitForTaskInput,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const REMOTE_PRINCIPAL_MARKER = "C8-REMOTE-PRINCIPAL:user:remote-http-child";

/**
 * Also covers the /eve/v1 callback-prefix regression (#3047): vercel.json
 * mounts this fixture at /eve/v1. The Vercel build check asserts the emitted
 * callback path is /eve/v1/callback/<token>, never /eve/v1/eve/v1/callback/<token>.
 * This existing eval then proves the child can deliver HITL and its final result
 * to the parent over that callback, and resume over its persisted HTTP route.
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

    const terminal = await waitForCompletedTask(t, gate.session, "TASK-C8-REMOTE-VERIFY", taskId);
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

    t.event("input.requested", {
      count: 1,
      data: { requests: [{ action: { toolName: "remote_gate" } }] },
    });
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

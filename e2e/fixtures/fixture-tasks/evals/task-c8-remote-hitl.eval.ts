import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForCompletedTask,
  waitForTaskInput,
} from "./shared.js";

const REMOTE_PRINCIPAL_MARKER = "C8-REMOTE-PRINCIPAL:user:remote-http-child";

/** A remote task's HITL answer must use its persisted HTTP child route. */
export default defineEval({
  description:
    "A loopback remote child surfaces HITL and resumes over its remote response route with the remote transport principal intact.",
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

    const terminal = await waitForCompletedTask(t, gate.session, "TASK-C8-REMOTE-VERIFY", taskId);
    terminal.expectOk();
    const view = requireTaskView(terminal.requireToolCall("task_peek").output, taskId);
    await t.require(
      view,
      satisfies(
        (task: Record<string, unknown>) =>
          Reflect.get(task, "status") === "completed" &&
          hasRemoteMetadata(task) &&
          hasRemotePrincipalOutput(task),
        "completed remote task retains remote mode and the HTTP child principal",
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

function hasRemoteMetadata(task: Record<string, unknown>): boolean {
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

import { describe, expect, it } from "vitest";
import { dispatchCoordinationStep } from "#execution/workflow-host/dispatch-step.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import { applySessionStateDelta } from "#execution/session/state-delta.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { createTask, findTask, readTaskTable, writeTaskTable } from "#execution/tasks/table.js";
import { workflowEntry } from "#execution/session/entry.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-references.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { withParkedStep } from "#internal/testing/session-machine.js";
import { mintClearance } from "#harness/clearance.js";
import { admitWorkflowTask } from "#harness/workflow-admission.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { deployServiceWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";

describe("coordination dispatch", () => {
  it("refuses unadmitted requests while admitted siblings prestart", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "workflow-admission" },
      modules: [
        {
          logicalPath: "tools/deploy.ts",
          loadNamespace: async () => ({
            default: defineWorkflowTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              execute: deployServiceWorkflow,
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const base: HarnessSession = {
        compaction: {},
        continuationToken: "http:workflow-admission",
        history: [],
        sessionId: "workflow-admission",
      };
      const request: RuntimeWorkflowTaskRequest = {
        callId: "legacy",
        entry: { entryPoint: "execute" },
        input: { service: "api" },
        kind: "workflow-task",
        toolName: "deploy",
        workflowId: "workflow//./agent/tools/deploy//execute",
      };
      const changed: RuntimeWorkflowTaskRequest = {
        ...admitWorkflowTask({ ...request, callId: "changed" }, mintClearance("changed")),
        input: { service: "other" },
      };
      const admitted = ["allowed-1", "allowed-2"].map((callId) =>
        admitWorkflowTask({ ...request, callId }, mintClearance(callId)),
      );
      // A refused task call drops the task its call recorded, so it never counts against the cap.
      const created = createTask(readTaskTable(undefined), {
        callId: "legacy-task",
        kind: "tool",
        name: "deploy",
        resumable: true,
        turnId: "turn-1",
      });
      const legacyTask: RuntimeWorkflowTaskRequest = {
        ...request,
        callId: "legacy-task",
        entry: { entryPoint: "task", taskId: created.taskId },
      };
      const calls = [request, changed, legacyTask, ...admitted];
      const session = withParkedStep(writeTaskTable(base, created.table), {
        messages: [
          {
            role: "assistant",
            content: calls.map((task) => ({
              input: task.input,
              toolCallId: task.callId,
              toolName: task.toolName,
              type: "tool-call" as const,
            })),
          },
        ],
        tasks: calls,
      });
      const before = await listWorkflowToolRunIds();
      const given = {
        serializedContext: buildSerializedContext({ channelKind: "http" }),
        sessionState: createDurableSessionState({ session }),
      };
      const dispatched = await dispatchCoordinationStep({
        ...given,
        workflowToolRunOwner: { inbox: "eve:test-inbox" },
      });
      expect(dispatched.pending.executing.map(({ callId }) => callId)).toEqual([
        "allowed-1",
        "allowed-2",
      ]);
      expect(dispatched.pending.started).toEqual([]);
      expect(dispatched.pending.refused).toMatchObject([
        { policy: "admission", result: { callId: "legacy" } },
        { policy: "admission", result: { callId: "changed" } },
        { policy: "admission", result: { callId: "legacy-task" } },
      ]);
      expect(dispatched.pending.refused[0]?.result).toMatchObject({
        isError: true,
        output: { code: "TOOL_EXECUTION_DENIED", tool: { result: "not_run" } },
      });
      expect(
        findTask(
          readTaskTable(
            readDurableSession(
              applySessionStateDelta({ ...given, history: [] }, dispatched.stateDelta).sessionState,
            ).state,
          ),
          created.taskId,
        ),
      ).toBeUndefined();
      const after = await listWorkflowToolRunIds();
      expect([...after].filter((id) => !before.has(id))).toHaveLength(2);
    });
  });

  it("cleans up the sandbox key of a session that started a run, though it never opened a sandbox", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "task-dispatch-sandbox-cleanup" },
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineWorkflowTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              task: deployServiceWorkflow,
            }),
          }),
        },
      ],
    });

    await runtime.run(async () => {
      // An agent the run opens can share the session's sandbox and create it
      // under the session's key, which the session's own state never records.
      const dispatching = await runUntilSessionEnds('Run deploy_service with service "api"');
      const plain = await runUntilSessionEnds("hello there");

      expect(runtime.sandboxCleanups).toEqual([dispatching, plain]);
    });
  }, 60_000);
});

async function runUntilSessionEnds(message: string): Promise<string> {
  const run = await startSessionOwner(workflowEntry, [
    {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message },
      serializedContext: buildSerializedContext({ channelKind: "http" }),
      sessionTimeoutMs: 25,
    },
  ]);
  const stream = captureEvents(run);
  try {
    await stream.nextUntil("session completion", (event) => event.type === "session.ended");
    await run.returnValue;
    return run.runId;
  } finally {
    stream.dispose();
  }
}

async function listWorkflowToolRunIds(): Promise<Set<string>> {
  const world = await getWorld();
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({
      pagination: { cursor, limit: 100 },
      resolveData: "none",
      workflowName: workflowToolRunWorkflowReference.workflowId,
    });
    for (const run of page.data) ids.add(run.runId);
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return ids;
}

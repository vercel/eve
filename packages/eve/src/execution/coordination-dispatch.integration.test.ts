import type { AnyEventRequest } from "@workflow/world";
import { describe, expect, it, vi } from "vitest";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { workflowEntry } from "#execution/session/entry.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { withParkedStep } from "#internal/testing/session-machine.js";
import { mintClearance } from "#harness/clearance.js";
import { admitWorkflowTask } from "#harness/workflow-admission.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { deployServiceWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { defineHook } from "#public/definitions/hook.js";
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
      const calls = [request, changed, ...admitted];
      const session = withParkedStep(base, {
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
      const dispatched = await dispatchCoordinationStep({
        serializedContext: buildSerializedContext({ channelKind: "http" }),
        sessionState: createDurableSessionState({ session }),
        workflowToolRunOwner: { inbox: "eve:test-inbox" },
      });
      expect(dispatched.pending.executing.map(({ callId }) => callId)).toEqual([
        "allowed-1",
        "allowed-2",
      ]);
      expect(dispatched.pending.started).toEqual([]);
      expect(dispatched.pending.refused).toMatchObject([
        { policy: "approval", result: { callId: "legacy" } },
        { policy: "approval", result: { callId: "changed" } },
      ]);
      const after = await listWorkflowToolRunIds();
      expect([...after].filter((id) => !before.has(id))).toHaveLength(2);
    });
  });

  it("starts a task's run once when the step that reports it started is retried", async () => {
    let reported = 0;
    const runtime = await createTestRuntime({
      agent: { name: "task-dispatch-retry" },
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
        {
          logicalPath: "hooks/task-board.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "task.started"() {
                  reported++;
                },
              },
            }),
          }),
        },
      ],
    });

    await runtime.run(async () => {
      const world = await getWorld();
      const before = await listWorkflowToolRunIds();
      let sessionId: string | undefined;
      let interrupted = false;
      // The step that ran the `task.started` hook loses its completion once, as
      // when its process exits before the step commits, so the step runs again.
      // With batching off, every event goes through `create`, so none can skip the fault.
      const createBatch = world.events.createBatch;
      world.events.createBatch = undefined;
      const createEvent = world.events.create.bind(world.events);
      const created = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
        const [runId, event] = args as [string, AnyEventRequest];
        if (
          !interrupted &&
          reported > 0 &&
          runId === sessionId &&
          event.eventType === "step_completed"
        ) {
          interrupted = true;
          throw new Error("The process exited before the step committed.");
        }
        return await createEvent(...args);
      });

      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            acceptedDeploymentId: "dpl_inline",
            channelKind: "http",
          }),
        },
      ]);
      sessionId = run.runId;
      const stream = captureTurnEvents(run);
      try {
        const events = await stream.nextTurn();
        expect(interrupted).toBe(true);
        expect(reported).toBe(1);
        expect(filterEventsByType(events, "task.ended").map((event) => event.data.outcome)).toEqual(
          ["completed"],
        );
        const started = [...(await listWorkflowToolRunIds())].filter((id) => !before.has(id));
        expect(started).toHaveLength(1);
      } finally {
        created.mockRestore();
        world.events.createBatch = createBatch;
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

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

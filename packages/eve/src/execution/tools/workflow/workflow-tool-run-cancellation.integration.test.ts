import { afterEach, describe, expect, it, vi } from "vitest";
import { getRun, getWorld, start } from "#internal/workflow/runtime.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { cancelBackgroundAgentTask } from "#execution/tools/subagent/task-cancel.js";
import { setAgentHandleStore } from "#subagents/handles/store.js";
import {
  holdUntilAbortedWorkflow,
  receiveDelegatedResultWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-runtime.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
  waitForWorkflowToolRunTerminal,
} from "#internal/testing/workflow-tool-run-harness.js";

describe("workflow tool cancellation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("fails the retained caller when a yielded child receives reset", async () => {
    const kind = "reset";
    const runtime = await createWorkflowToolRuntime({
      agentName: `yielded-child-${kind}`,
      background: true,
      execute: holdUntilAbortedWorkflow,
      toolName: "deploy_service",
    });
    await runtime.run(async () => {
      const parentToken = `parent-result-${kind}`;
      const parent = await start(receiveDelegatedResultWorkflow, [parentToken]);
      let child: ReturnType<typeof getRun> | undefined;
      let stream: ReturnType<typeof captureTurnEvents> | undefined;
      let nestedRunId: string | undefined;
      try {
        await waitForHook(parent, { token: parentToken });
        const before = await listWorkflowToolRunIds();
        child = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: 'Run deploy_service with service "api"' },
            serializedContext: {
              ...buildWorkflowToolSerializedContext({
                continuationToken: `child-${kind}`,
                mode: "conversation",
              }),
              "eve.channel": {
                kind: "subagent",
                state: {
                  callId: "delegate",
                  subagentName: "detector",
                  parentContinuationToken: parentToken,
                  parentSessionId: parent.runId,
                },
              },
            },
          },
        ]);
        stream = captureTurnEvents(child);
        const yielded = await stream.nextTurn();
        expect(filterEventsByType(yielded, "turn.completed")).toHaveLength(1);
        expect(yielded.at(-1)?.type).toBe("session.waiting");
        nestedRunId = await waitForNewWorkflowToolRun(before);
        await waitForHook({ runId: nestedRunId });
        expect(await parent.status).toBe("running");
        await resumeSessionInbox(sessionCommandHookToken(child.runId), { kind });
        await expect(parent.returnValue).resolves.toMatchObject({
          kind: "runtime-action-result",
          results: [
            {
              callId: "delegate",
              isError: true,
              outcome: {
                kind: "terminal",
                result: { kind: "failed" },
              },
            },
          ],
        });
        await expect(child.returnValue).resolves.toEqual({
          output: "The session ended before the delegated task completed.",
        });
        expect(await waitForWorkflowToolRunTerminal(nestedRunId)).toBe("completed");
      } finally {
        stream?.dispose();
        if (nestedRunId !== undefined) {
          const nested = getRun(nestedRunId);
          const status = await nested.status;
          if (status === "pending" || status === "running") await nested.cancel();
        }
        for (const run of [child, parent]) {
          if (run === undefined) continue;
          const status = await run.status;
          if (status === "pending" || status === "running") await run.cancel();
        }
      }
    });
  }, 30_000);

  it("cancels nested work after its owning child has yielded", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "yielded-child-cancel",
      background: true,
      execute: holdUntilAbortedWorkflow,
      toolName: "deploy_service",
    });
    await runtime.run(async () => {
      const before = await listWorkflowToolRunIds();
      const child = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:yielded-child-cancel",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(child);
      let nestedRunId: string | undefined;
      try {
        const yielded = await stream.nextTurn();
        expect(filterEventsByType(yielded, "turn.completed")).toHaveLength(1);
        expect(yielded.at(-1)?.type).toBe("session.waiting");
        nestedRunId = await waitForNewWorkflowToolRun(before);
        await waitForHook({ runId: nestedRunId });
        expect(await getRun(nestedRunId).status).toBe("running");

        await cancelBackgroundAgentTask({
          entry: {
            callId: "delegate",
            toolName: "child",
            lifetime: "session",
            origin: { turnId: "parent-turn", stepIndex: 0 },
            address: { runId: child.runId, hookToken: "unused" },
            task: {
              taskId: "outer-task",
              metadata: { kind: "subagent", name: "child" },
              dispatchContext: { auth: { current: null, initiator: null } },
            },
          },
          session: {
            state: setAgentHandleStore(undefined, {
              handles: [
                {
                  phase: "claimed",
                  ownerId: "outer-task",
                  operationId: "delegate",
                  identity: { id: "child", name: "child", nodeId: "subagents/child" },
                  address: {
                    kind: "agent/local",
                    sessionId: child.runId,
                    continuationToken: "child",
                  },
                },
              ],
            }),
          },
          serializedContext: {},
        });

        // The held step can finish only after its abort signal fires or its 60s timer expires.
        // Finishing within 15s proves cancellation reached the yielded child's work.
        expect(await waitForWorkflowToolRunTerminal(nestedRunId)).toBe("completed");

        // This input follows the cancellation notification in the child's inbox.
        // It must be the next turn, without a task notification waking the child first.
        await resumeSessionInbox(sessionCommandHookToken(child.runId), {
          kind: "send",
          payload: { message: "Hello again" },
        });
        const next = await stream.nextTurn();
        expect(
          filterEventsByType(next, "message.received").map((event) => event.data.message),
        ).toEqual(["Hello again"]);
        expect(filterEventsByType(next, "turn.failed")).toHaveLength(0);
      } finally {
        stream.dispose();
        if (nestedRunId !== undefined) {
          const nested = getRun(nestedRunId);
          const status = await nested.status;
          if (status === "pending" || status === "running") await nested.cancel();
        }
        await child.cancel();
      }
    });
  }, 30_000);

  it("cancels the run when the waiting turn is cancelled and lets the body clean up", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-cancel",
      execute: holdUntilAbortedWorkflow,
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      const before = await listWorkflowToolRunIds();
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            acceptedDeploymentId: "dpl_inline",
            continuationToken: "http:workflow-tool-cancel",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const workflowToolRunId = await waitForNewWorkflowToolRun(before);
        await waitForHook({ runId: workflowToolRunId });
        const commandToken = sessionCommandHookToken(run.runId);
        await resumeSessionInbox(commandToken, { kind: "cancel", turnId: "turn_0" });

        // The body is holding in a step that received ctx.abortSignal, so the
        // run ends well inside its grace period once the step rejects and
        // `finally` runs; a run that ignored the signal would still be running.
        expect(await waitForWorkflowToolRunTerminal(workflowToolRunId)).toBe("completed");

        await resumeSessionInbox(commandToken, {
          kind: "send",
          payload: { message: "Thanks, no deploy today." },
        });
        const next = await stream.nextTurn();
        expect(filterEventsByType(next, "turn.started")).toHaveLength(1);
        expect(filterEventsByType(next, "turn.failed")).toHaveLength(0);
        expect(next.at(-1)?.type).toBe("session.waiting");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});

/** Ids of every workflow tool run in the shared world, so a test can spot the one it started. */
async function listWorkflowToolRunIds(): Promise<Set<string>> {
  const world = await getWorld();
  const page = await world.runs.list({ pagination: { limit: 100 } });
  return new Set(
    page.data
      .filter(
        (entry: { readonly workflowName?: string }) =>
          entry.workflowName === workflowToolRunWorkflowReference.workflowId,
      )
      .map((entry: { readonly runId: string }) => entry.runId),
  );
}

/** Polls until exactly one workflow tool run exists that was not in `before`. */
async function waitForNewWorkflowToolRun(
  before: ReadonlySet<string>,
  timeout = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const started = [...(await listWorkflowToolRunIds())].filter((runId) => !before.has(runId));
    if (started.length === 1) return started[0]!;
    if (started.length > 1)
      throw new Error(`Expected one new workflow tool run, found ${started.length}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a workflow tool run to start.");
}

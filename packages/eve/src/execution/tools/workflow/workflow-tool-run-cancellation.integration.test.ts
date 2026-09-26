import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { holdUntilAbortedWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-runtime.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
  waitForWorkflowToolRunTerminal,
} from "#internal/testing/workflow-tool-run-harness.js";

describe("workflow tool cancellation", () => {
  afterEach(() => vi.unstubAllEnvs());
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
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const workflowToolRunId = await waitForNewWorkflowToolRun(before);
        await waitForHook({ runId: workflowToolRunId });
        const commandToken = sessionCommandHookToken(run.runId);
        await resumeSessionInbox(commandToken, { kind: "cancel", turnId: "turn_0" });

        // The body is holding in a step that received the call's abortSignal, so the
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

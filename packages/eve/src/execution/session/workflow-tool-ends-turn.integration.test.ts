import { describe, expect, it } from "vitest";

import { summarizeTurnEvents } from "#client/session-utils.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import {
  deployServiceWorkflow,
  holdUntilAbortedWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import type { WorkflowExecuteToolDefinition } from "#tools/workflow-definition.js";

/**
 * Runs one turn whose model calls an `execute` workflow tool, and returns the turn's events. With
 * `steer`, that message arrives while the call runs.
 */
async function runDeployTool(
  agentName: string,
  endsTurn: WorkflowExecuteToolDefinition["endsTurn"],
  {
    execute = deployServiceWorkflow,
    steer,
  }: { execute?: (...args: never[]) => unknown; steer?: string } = {},
) {
  const runtime = await createWorkflowToolRuntime({
    agentName,
    endsTurn,
    execute,
    toolName: "deploy_service",
  });
  return await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: 'Run deploy_service with service "api"' },
        serializedContext: buildWorkflowToolSerializedContext({
          continuationToken: `http:${agentName}`,
        }),
      },
    ]);
    const stream = captureTurnEvents(run);
    try {
      if (steer === undefined) return await stream.nextTurn();
      const started = await stream.nextUntil((event) => event.type === "call.started");
      await resumeSessionInbox(sessionCommandHookToken(run.runId), {
        delivery: { channelKind: "http", channelName: "test", deliveryId: "steer" },
        kind: "send",
        payload: { message: steer },
      });
      return [...started, ...(await stream.nextUntil((event) => event.type === "turn.settled"))];
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
}

describe("a workflow tool's endsTurn", () => {
  it("settles the turn on the call's result, with no second model call and no reply", async () => {
    const outputs: unknown[] = [];
    const turn = await runDeployTool("workflow-tool-ends-turn-true", (output) => {
      outputs.push(output);
      return true;
    });

    expect(outputs).toEqual([expect.objectContaining({ plan: "plan:api" })]);
    expect(filterEventsByType(turn, "model.settled")).toHaveLength(1);
    expect(summarizeTurnEvents(turn).message).toBeUndefined();
  }, 60_000);

  it("lets the model answer when the call's output doesn't end the turn", async () => {
    const turn = await runDeployTool("workflow-tool-ends-turn-false", () => false);

    expect(filterEventsByType(turn, "model.settled")).toHaveLength(2);
    expect(summarizeTurnEvents(turn).message).toContain("Used deploy_service");
  }, 60_000);

  it("lets the model answer a message the user sent while the call ran", async () => {
    const turn = await runDeployTool("workflow-tool-ends-turn-steered", true, {
      execute: holdUntilAbortedWorkflow,
      steer: "Also, notify Bob.",
    });

    expect(filterEventsByType(turn, "model.settled")).toHaveLength(2);
    expect(summarizeTurnEvents(turn).message).toContain("Also, notify Bob.");
  }, 60_000);
});

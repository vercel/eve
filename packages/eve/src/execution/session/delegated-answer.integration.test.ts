import { describe, expect, it } from "vitest";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { defineTool } from "#tools/definition.js";
import { always } from "#tools/approval/policies.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

describe("delegated agent approval answers", () => {
  it("does not accept a parent agent message as an approval response", async () => {
    const executions: string[] = [];
    const runtime = await createTestRuntime({
      agent: { name: "delegated-answer" },
      modules: [
        {
          logicalPath: "tools/approve_change.ts",
          loadNamespace: async () => ({
            default: defineTool({
              approval: always(),
              description: "Apply a change after it is approved.",
              execute: () => {
                executions.push("approve_change");
                return { applied: true };
              },
              inputSchema: {},
            }),
          }),
        },
      ],
    });
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const childContinuationToken = "subagent:parent-session:call-1";

    await runtime.run(async () => {
      const child = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Use the approve_change tool exactly once." },
          serializedContext: {
            ...buildSerializedContext({
              auth: ALICE,
              channelKind: "subagent",
              channelState: {
                callId: "call-1",
                parentContinuationToken: sessionInboxHookToken(childContinuationToken),
                parentSessionId: "parent-session",
                subagentName: "researcher",
              },
              continuationToken: childContinuationToken,
            }),
            "eve.capabilities": { requestInput: true },
          },
        },
      ]);
      const stream = captureTurnEvents(child);

      try {
        const held = await withTimeout(stream.nextTurn(), "child approval");
        const approval = filterEventsByType(held, "interaction.opened").find(
          ({ data }) => data.request.kind === "approval",
        );
        expect(approval).toBeDefined();
        expect(filterEventsByType(held, "turn.paused")).toMatchObject([
          {
            data: { awaiting: [{ interactionId: approval!.data.interactionId }] },
            type: "turn.paused",
          },
        ]);

        await expect(
          workflowRuntime.dispatchSession({
            command: {
              auth: ALICE,
              caller: {
                callId: "call-1",
                replyTo: { kind: "hook", token: sessionInboxHookToken(childContinuationToken) },
                subagentName: "researcher",
              },
              kind: "send",
              payload: { message: "approve" },
            },
            sessionId: child.runId,
          }),
        ).resolves.toMatchObject({ sessionId: child.runId, status: "accepted" });

        // The parent's message steers the held turn, so it withdraws the approval instead of answering it.
        const resumed = await withTimeout(stream.nextTurn(), "delegated approval answer");
        const outcomes = filterEventsByType(resumed, "interaction.settled")
          .filter(({ data }) => data.interactionId === approval!.data.interactionId)
          .map(({ data }) => data.outcome);
        expect({ executions, outcomes }).toEqual({ executions: [], outcomes: ["withdrawn"] });
      } finally {
        stream.dispose();
        await child.cancel();
      }
    });
  }, 60_000);
});

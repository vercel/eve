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
        const request = filterEventsByType(held, "input.requested")[0]?.data.requests[0];
        expect(request?.kind).toBe("tool-approval");
        expect(held.at(-1)).toMatchObject({ data: { on: "input" }, type: "turn.waiting" });

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
        ).resolves.toEqual({ sessionId: child.runId, status: "accepted" });

        const resumed = await withTimeout(stream.nextTurn(), "delegated approval answer");
        const approvedRequests = filterEventsByType(resumed, "approval.settled")
          .filter(({ data }) => data.outcome === "approved")
          .map(({ data }) => data.requestId);
        expect({ approvedRequests, executions }).toEqual({ approvedRequests: [], executions: [] });
      } finally {
        stream.dispose();
        await child.cancel();
      }
    });
  }, 60_000);
});

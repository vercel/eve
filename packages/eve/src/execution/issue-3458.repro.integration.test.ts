import { describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { runModelCallBatch } from "#execution/model-call-batching.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { appendPendingInputBatch, hasPendingInputBatch } from "#harness/input-requests.js";
import type { HarnessSession, StepResult } from "#harness/types.js";

const SESSION_ID = "child-session-steered-during-proxied-approval";
const CONTINUATION_TOKEN = "subagent:worker:approval";
const REQUEST_ID = "approval-r1";

function cancelledChildWithProxiedApproval(): HarnessSession {
  const session = setHarnessEmissionState(
    {
      agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: CONTINUATION_TOKEN,
      history: [],
      sessionId: SESSION_ID,
    },
    { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: "turn_1" },
  );
  return appendPendingInputBatch({
    event: { sequence: 3, stepIndex: 1, turnId: "turn_1" },
    requests: [
      {
        action: {
          callId: "gated-call-r1",
          input: { subject: "reported steering reproduction" },
          kind: "tool-call",
          toolName: "gated",
        },
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Approve tool call: gated",
        requestId: REQUEST_ID,
      },
    ],
    responseAuthRequiredRequestIds: [REQUEST_ID],
    responseMessages: [],
    session,
  });
}

function context(): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: "http", state: {} },
    "eve.continuationToken": CONTINUATION_TOKEN,
    "eve.mode": "task",
    "eve.sessionId": SESSION_ID,
  };
}

describe("repro #3458: steering a child parked on a proxied approval", () => {
  it("settles the child's now-unanswerable approval batch during cancellation", async () => {
    const runtime = await createTestRuntime({ agent: { name: "issue-3458-repro" } });

    await runtime.run(async () => {
      const childBeforeCancellation = cancelledChildWithProxiedApproval();
      expect(hasPendingInputBatch(childBeforeCancellation.state)).toBe(true);

      const cancelled = await settleCancelledTurnStep({
        sessionWritable: new WritableStream<Uint8Array>({ write() {} }),
        serializedContext: context(),
        sessionState: createDurableSessionState({ session: childBeforeCancellation }),
      });

      expect(hasPendingInputBatch(cancelled.sessionState.snapshot.session.state)).toBe(false);
    });
  });

  it("does not let the stale batch stop a later turn after one model call", async () => {
    const runtime = await createTestRuntime({ agent: { name: "issue-3458-repro" } });

    await runtime.run(async () => {
      const cancelled = await settleCancelledTurnStep({
        sessionWritable: new WritableStream<Uint8Array>({ write() {} }),
        serializedContext: context(),
        sessionState: createDurableSessionState({ session: cancelledChildWithProxiedApproval() }),
      });
      const cancelledSession = cancelled.sessionState.snapshot.session;
      const stalledSession: HarnessSession = {
        ...cancelledSession,
        agent: {
          ...cancelledSession.agent,
          modelReference: { id: "openai/gpt-5.4" },
          tools: [],
        },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
      };
      let result: StepResult;
      result = {
        next: async () => result,
        session: stalledSession,
      };
      const runStep = vi.fn(async () => result);

      await runModelCallBatch({
        initialInput: { message: "new task input" },
        initialSession: stalledSession,
        modelCallsPerStep: 2,
        runStep,
      });

      expect(runStep).toHaveBeenCalledTimes(2);
    });
  });
});

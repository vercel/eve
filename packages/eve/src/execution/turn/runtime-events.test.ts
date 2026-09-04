import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyRuntimeEvents } from "#execution/turn/runtime-events.js";
import { createDurableSessionState } from "#execution/session/state.js";
import { recordWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import type { InboxEnvelope } from "#execution/inbox/types.js";
import type { HarnessSession } from "#harness/types.js";

const mocks = vi.hoisted(() => ({
  proxy: vi.fn(),
  report: vi.fn(),
  cancel: vi.fn(),
  release: vi.fn(),
  request: vi.fn(),
}));
vi.mock("#subagents/event-proxy-step.js", () => ({ runProxySubagentEvent: mocks.proxy }));
vi.mock("#execution/workflow-tool/emit-workflow-tool-run-report-step.js", () => ({
  emitWorkflowToolRunReport: mocks.report,
}));
vi.mock("#execution/tools/subagent/task-cancel.js", () => ({
  cancelAgentInvocationOwner: mocks.cancel,
}));
vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  releaseAgentInvocationOwner: mocks.release,
}));
vi.mock("#execution/tools/subagent/task-agent-requests.js", () => ({
  applyTaskAgentRequest: mocks.request,
}));

function fixture() {
  const session = recordWorkflowToolRun<HarnessSession>(
    {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 10000 },
      continuationToken: "session",
      history: [],
      sessionId: "session",
    } satisfies HarnessSession,
    {
      callId: "call",
      hookToken: "tool-owner",
      resultKind: "tool",
      runId: "tool-run",
      toolName: "deploy",
    },
  );
  const state = createDurableSessionState({ session });
  mocks.release.mockResolvedValue({ sessionState: state });
  return {
    state,
    owner: { ownerRunId: "turn-run", token: "turn-owner" },
    serializedContext: {},
    eventsWriter: new WritableStream<Uint8Array>(),
  };
}
const from = {
  callId: "call",
  execution: "blocking",
  input: {},
  runId: "tool-run",
  sequence: 0,
  stepIndex: 0,
  toolName: "deploy",
  turnId: "turn",
};
beforeEach(() => vi.resetAllMocks());

describe("runtime owner event application", () => {
  it("accepts the recorded workflow outcome and rejects a different run", async () => {
    const result = await applyRuntimeEvents({
      ...fixture(),
      events: [
        {
          eventId: "foreign",
          kind: "tool.outcome",
          payload: {
            from: { ...from, runId: "foreign" },
            result: { status: "completed", output: "wrong" },
          },
        },
        {
          eventId: "owned",
          kind: "tool.outcome",
          payload: { from, result: { status: "completed", output: "right" } },
        },
      ],
    });
    expect(result.results).toEqual([
      { callId: "call", kind: "tool-result", output: "right", toolName: "deploy" },
    ]);
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it("validates runtime result calls and preserves independent results only once", async () => {
    const valid = { callId: "call", kind: "tool-result", output: "done", toolName: "deploy" };
    const result = await applyRuntimeEvents({
      ...fixture(),
      events: [
        {
          eventId: "results",
          kind: "runtime.result",
          payload: {
            kind: "runtime-action-result",
            results: [valid, { ...valid, callId: "other" }, valid],
          },
        },
      ],
    });
    expect(result.results).toEqual([valid]);
  });

  it("rejects stale owner targets and unbound child authorization", async () => {
    const events: InboxEnvelope[] = [
      {
        eventId: "report",
        kind: "tool.report",
        payload: { from, update: "hidden" },
        target: { ownerRunId: "old-turn" },
      },
      {
        eventId: "auth",
        kind: "runtime.result",
        payload: {
          kind: "subagent-authorization-event",
          callId: "unknown",
          childSessionId: "foreign",
          subagentName: "worker",
        },
      },
    ];
    const result = await applyRuntimeEvents({ ...fixture(), events });
    expect(result.results).toEqual([]);
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
});

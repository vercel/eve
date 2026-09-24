import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { resumeWorkflowToolRunAnswers } from "#execution/tools/workflow/answer.js";
import { getProxyInputRequests, type AnswerHookRoute } from "#harness/proxy-input-requests.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import type { InputRequest } from "#shared/input.js";
import { emitProxiedSubagentEvent } from "#subagents/event-proxy-step.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";

vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: vi.fn() }));
vi.mock("#execution/tools/workflow/answer.js", () => ({
  resumeWorkflowToolRunAnswers: vi.fn(),
  resumeWorkflowToolRunDismissal: vi.fn(),
}));

// The clock rule through the HITL proxy path: a child's surfaced request
// stops its task's deadline clock, and answering it resumes the clock.

const DEADLINE = "2026-09-24T14:00:00.000Z";
const ASKED = "2026-09-24T13:00:00.000Z";
const adapter: ChannelAdapter = { kind: "clock-test" };
const turnAgent = {
  id: "test-agent",
  instructions: [],
  model: { id: "test-model" },
  skills: [],
  tools: [],
  workspaceSpec: {} as never,
};
const bundle: CompiledBundle = {
  adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
  compiledArtifactsSource: {} as never,
  graph: { nodesByNodeId: new Map(), root: { sandboxRegistry: { sandbox: null }, turnAgent } },
  hookRegistry: createEmptyHookRegistry(),
  resolvedAgent: { config: {} },
  subagentRegistry: {},
  toolRegistry: {},
  turnAgent,
} as never;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-24T13:30:00.000Z"), toFake: ["Date"] });
  vi.mocked(resumeSessionInbox).mockReset();
  vi.mocked(resumeWorkflowToolRunAnswers).mockReset();
  return () => vi.useRealTimers();
});

describe("task clock through the HITL proxy", () => {
  it("stops a local child's clock on its question and resumes it once the answer is routed", async () => {
    const task = createTaskRecord({
      child: { continuationToken: "child-token", kind: "local", sessionId: "child-session" },
      deadlineAt: DEADLINE,
    });

    const asked = await proxy(task, {
      childContinuationToken: "child-token",
      childSessionId: "child-session",
    });
    expect(records(asked)[0]).toMatchObject({
      clockStoppedAt: ASKED,
      deadlineAt: DEADLINE,
      status: "input_required",
    });
    expect(getProxyInputRequests(stateOf(asked)).get("request-1")).toMatchObject({
      taskId: task.id,
    });

    const answered = await answer(asked);

    expect(resumeSessionInbox).toHaveBeenCalledOnce();
    expect(getProxyInputRequests(stateOf(answered)).size).toBe(0);
    // Thirty minutes waiting on the human extend the deadline by thirty minutes.
    expect(records(answered)[0]).toMatchObject({
      deadlineAt: "2026-09-24T14:30:00.000Z",
      status: "working",
    });
    expect(records(answered)[0]).not.toHaveProperty("clockStoppedAt");
  });

  it("does the same for a workflow task's ctx.ask routed by its answer hook", async () => {
    const task = createTaskRecord({
      child: { commandToken: "command-1", kind: "workflow", runId: "run-1" },
      deadlineAt: DEADLINE,
      id: "deploy-abc234",
      kind: "workflow",
      name: "deploy",
    });

    const asked = await proxy(
      task,
      { childContinuationToken: "answer-hook-1", childSessionId: "run-1" },
      { runId: "run-1" },
    );
    expect(records(asked)[0]).toMatchObject({ status: "input_required" });

    const answered = await answer(asked);

    expect(resumeWorkflowToolRunAnswers).toHaveBeenCalledWith("answer-hook-1", [
      { requestId: "request-1", text: "Yes" },
    ]);
    expect(records(answered)[0]).toMatchObject({
      deadlineAt: "2026-09-24T14:30:00.000Z",
      status: "working",
    });
  });
});

async function proxy(
  task: TaskRecord,
  child: { readonly childContinuationToken: string; readonly childSessionId: string },
  answerHook?: AnswerHookRoute,
): Promise<DurableSessionState> {
  const request: InputRequest = {
    action: { callId: task.callId, input: {}, kind: "tool-call", toolName: task.name },
    kind: "question",
    prompt: "Ship it?",
    requestId: "request-1",
  };
  const hookPayload: SubagentInputRequestHookPayload = {
    ...child,
    callId: task.callId,
    event: { requests: [request], sequence: 1, stepIndex: 0, turnId: "child-turn" },
    kind: "subagent-input-request",
    subagentName: task.name,
  };
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "http:parent");
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionIdKey, "parent");
  const result = await emitProxiedSubagentEvent({
    answerHook,
    ctx,
    durableSession: readDurableSession(
      createDurableSessionState({
        session: {
          agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
          compaction: { recentWindowSize: 10, threshold: 100_000 },
          continuationToken: "http:parent",
          history: [],
          sessionId: "parent",
          state: taskTableState([task]),
        },
      }),
    ),
    hookPayload,
    now: ASKED,
    sessionWritable: new WritableStream<Uint8Array>(),
    taskId: task.id,
  });
  return result.sessionState;
}

async function answer(sessionState: DurableSessionState): Promise<DurableSessionState> {
  const routed = await routeProxiedDeliverStep({
    delivery: {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "request-1", text: "Yes" }] }],
    },
    sessionState,
    sessionWritable: new WritableStream<Uint8Array>(),
  });
  expect(routed).toMatchObject({ kind: "continue", remainder: undefined });
  return routed.sessionState;
}

function stateOf(state: DurableSessionState) {
  return readDurableSession(state).state;
}

function records(state: DurableSessionState): readonly TaskRecord[] {
  return getTaskTable(readDurableSession(state)).records;
}

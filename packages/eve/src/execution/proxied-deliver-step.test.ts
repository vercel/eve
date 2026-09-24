import { beforeEach, describe, expect, it, vi } from "vitest";

import { deserializeContext } from "#context/serialize.js";
import { ContextContainer } from "#context/container.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  getProxyInputRequests,
  remoteChildRouteToken,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { TaskRecord } from "#tasks/record.js";
import { encodeTaskCreator } from "#tasks/results.js";
import { TASK_CALLBACK_ALIAS_STATE_KEY } from "#tasks/state.js";
import { answerRemoteTask } from "#tasks/transport.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: vi.fn() }));
vi.mock("#tasks/transport.js", () => ({ answerRemoteTask: vi.fn() }));

const ALIAS = "eve:task-callback:owner-alias";
const REMOTE_CHILD = {
  callbackBaseUrl: "https://owner.example",
  kind: "remote" as const,
  sessionId: "remote-1",
  url: "https://billing.example",
};
const LOCAL_CHILD = {
  continuationToken: "child-token",
  kind: "local" as const,
  sessionId: "child-session",
};
const ALICE = {
  attributes: {},
  authenticator: "slack",
  principalId: "U-alice",
  principalType: "user",
} as const;
const BOB = {
  attributes: {},
  authenticator: "slack",
  principalId: "U-bob",
  principalType: "user",
} as const;
const remote = createTaskRecord({
  child: REMOTE_CHILD,
  creator: encodeTaskCreator({ auth: ALICE }),
  name: "billing",
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(deserializeContext).mockResolvedValue(new ContextContainer());
});

describe("answering a remote child's input request", () => {
  it("sends the answer to the remote child and retires the request", async () => {
    vi.mocked(answerRemoteTask).mockResolvedValueOnce({ kind: "answered" });

    const routed = await route(remote, remoteChildRouteToken("remote-1"));

    // The answer carries its answerer, the responder an approval policy checks.
    expect(answerRemoteTask).toHaveBeenCalledExactlyOnceWith({
      auth: BOB,
      ctx: expect.any(ContextContainer),
      inputResponses: [{ optionId: "approve", requestId: "req-1" }],
      record: remote,
    });
    expect(resumeSessionInbox).not.toHaveBeenCalled();
    expect(routed).toMatchObject({ kind: "continue", remainder: undefined });
    expect(getProxyInputRequests(stateOf(routed.sessionState)).size).toBe(0);
  });

  it("keeps the request answerable when the answer may still reach the remote child", async () => {
    vi.mocked(answerRemoteTask).mockResolvedValueOnce({ kind: "retry" });

    const routed = await route(remote, remoteChildRouteToken("remote-1"));

    expect(getProxyInputRequests(stateOf(routed.sessionState)).has("req-1")).toBe(true);
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it("fails the task through the owner's inbox when the answer can never reach the child", async () => {
    const error = { code: "AGENT_SESSION_ENDED", message: "The agent's session ended." };
    vi.mocked(answerRemoteTask).mockResolvedValueOnce({ childEnded: true, error, kind: "failed" });

    const routed = await route(remote, remoteChildRouteToken("remote-1"));

    // The failure takes the path of the child's own result, so the owner settles it once.
    expect(resumeHook).toHaveBeenCalledExactlyOnceWith(sessionInboxHookToken(ALIAS), {
      kind: "runtime-action-result",
      results: [
        {
          callId: remote.callId,
          isError: true,
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: "terminal",
            result: { error, kind: "failed" },
            usageDelta: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
          output: error,
          subagentName: "billing",
        },
      ],
      source: { kind: "remote", sessionId: "remote-1" },
    });
    expect(getProxyInputRequests(stateOf(routed.sessionState)).size).toBe(0);
  });
});

describe("answering a local child's input request", () => {
  it("delivers the answer attributed to its answerer, like a remote child's", async () => {
    const local = createTaskRecord({
      child: LOCAL_CHILD,
      creator: encodeTaskCreator({ auth: ALICE }),
      name: "research",
    });

    await route(local, "child-token");

    expect(resumeSessionInbox).toHaveBeenCalledExactlyOnceWith(
      "child-token",
      expect.objectContaining({
        auth: BOB,
        payloads: [{ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }],
      }),
    );
  });
});

async function route(record: TaskRecord, childContinuationToken: string) {
  return await routeProxiedDeliverStep({
    delivery: {
      auth: BOB,
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }],
    },
    serializedContext: {},
    sessionState: ownerState(record, childContinuationToken),
    sessionWritable: new WritableStream<Uint8Array>(),
  });
}

function ownerState(record: TaskRecord, childContinuationToken: string): DurableSessionState {
  const state = upsertProxyInputRequestState({
    entries: [["req-1", { childContinuationToken, kind: "tool-approval", taskId: record.id }]],
    forChildContinuationToken: childContinuationToken,
    state: { ...taskTableState([record]), [TASK_CALLBACK_ALIAS_STATE_KEY]: ALIAS },
  });
  return createDurableSessionState({
    session: {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 5, threshold: 10_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent",
      state,
    },
  });
}

function stateOf(state: DurableSessionState) {
  return readDurableSession(state).state;
}

import { beforeEach, describe, expect, it, vi } from "vitest";

import { deserializeContext } from "#context/serialize.js";
import { ContextContainer } from "#context/container.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  getProxyInputRequests,
  remoteChildRouteToken,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { answerRemoteTask } from "#tasks/transport.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: vi.fn() }));
vi.mock("#tasks/transport.js", () => ({ answerRemoteTask: vi.fn() }));

const REMOTE_CHILD = {
  callbackBaseUrl: "https://owner.example",
  kind: "remote" as const,
  sessionId: "remote-1",
  url: "https://billing.example",
};
const BOB = {
  attributes: {},
  authenticator: "slack",
  principalId: "U-bob",
  principalType: "user",
} as const;
const record = createTaskRecord({ child: REMOTE_CHILD, name: "billing" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(deserializeContext).mockResolvedValue(new ContextContainer());
});

describe("answering a remote child's input request", () => {
  it("sends the answer to the remote child as the answering user and retires the request", async () => {
    vi.mocked(answerRemoteTask).mockResolvedValueOnce(true);

    const routed = await route();

    expect(answerRemoteTask).toHaveBeenCalledExactlyOnceWith({
      auth: BOB,
      ctx: expect.any(ContextContainer),
      inputResponses: [{ optionId: "approve", requestId: "req-1" }],
      record,
    });
    expect(resumeSessionInbox).not.toHaveBeenCalled();
    expect(routed).toMatchObject({ kind: "continue", remainder: undefined });
    expect(getProxyInputRequests(stateOf(routed.sessionState)).size).toBe(0);
  });

  it("keeps the request answerable when the answer does not reach the remote child", async () => {
    vi.mocked(answerRemoteTask).mockResolvedValueOnce(false);

    const routed = await route();

    expect(getProxyInputRequests(stateOf(routed.sessionState)).has("req-1")).toBe(true);
  });
});

async function route() {
  return await routeProxiedDeliverStep({
    delivery: {
      auth: BOB,
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "approve", requestId: "req-1" }] }],
    },
    serializedContext: {},
    sessionState: ownerState(),
    sessionWritable: new WritableStream<Uint8Array>(),
  });
}

function ownerState(): DurableSessionState {
  const state = upsertProxyInputRequestState({
    entries: [
      [
        "req-1",
        {
          childContinuationToken: remoteChildRouteToken("remote-1"),
          kind: "tool-approval",
          taskId: record.id,
        },
      ],
    ],
    forChildContinuationToken: remoteChildRouteToken("remote-1"),
    state: taskTableState([record]),
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

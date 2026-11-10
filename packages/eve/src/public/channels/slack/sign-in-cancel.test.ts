import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type { Runtime } from "#channel/types.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";
import {
  dispatchSignInCancel,
  dispatchSignInConnect,
  SIGN_IN_CANCEL_ACTION_ID,
  SIGN_IN_CONNECT_ACTION_ID,
} from "#public/channels/slack/sign-in-cancel.js";

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));

vi.mock("#internal/logging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#internal/logging.js")>();
  return {
    ...actual,
    createLogger: (namespace: string) =>
      namespace === "slack.interactions"
        ? { ...actual.createLogger(namespace), ...logger }
        : actual.createLogger(namespace),
  };
});

const RESPONSE_URL = "https://hooks.slack.com/actions/T1/1/abc";

function createRuntime(dispatchContinuation: Runtime["dispatchContinuation"]): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation,
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(),
    getLineStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn(),
  };
}

function cancelClick(): Record<string, unknown> {
  return {
    actions: [
      {
        action_id: SIGN_IN_CANCEL_ACTION_ID,
        value: JSON.stringify({ channelId: "C1", threadTs: "1.2", turnId: "turn_1" }),
      },
    ],
    response_url: RESPONSE_URL,
    type: "block_actions",
  };
}

async function clickCancel(runtime: Runtime): Promise<void> {
  const { from } = createChannelOperations<SlackChannelState>({
    adapter: { kind: "slack" },
    channelName: "slack",
    runtime,
  });
  const tasks: Promise<unknown>[] = [];
  expect(dispatchSignInCancel(cancelClick(), { from, waitUntil: (task) => tasks.push(task) })).toBe(
    true,
  );
  await Promise.all(tasks);
}

function stubFetch(response = new Response("ok")) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const deletePost = [
  RESPONSE_URL,
  {
    body: JSON.stringify({ delete_original: true }),
    headers: { "content-type": "application/json" },
    method: "POST",
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("dispatchSignInCancel", () => {
  it("removes the prompt after cancelling the held turn", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(
      vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
    );

    await clickCancel(runtime);

    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: { deliveryId: expect.any(String), kind: "cancel", turnId: "turn_1" },
      continuationToken: expect.stringContaining("C1"),
    });
    expect(fetchMock).toHaveBeenCalledWith(...deletePost);
  });

  it("starts removing the prompt before the cancel settles", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn().mockReturnValue(new Promise(() => {})));
    const { from } = createChannelOperations<SlackChannelState>({
      adapter: { kind: "slack" },
      channelName: "slack",
      runtime,
    });

    dispatchSignInCancel(cancelClick(), { from, waitUntil: () => {} });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(...deletePost));
    expect(runtime.dispatchContinuation).toHaveBeenCalled();
  });

  it("removes the prompt when the held turn has already ended", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn().mockResolvedValue({ status: "no_active_turn" }));

    await clickCancel(runtime);

    expect(fetchMock).toHaveBeenCalledWith(...deletePost);
  });

  it("removes the prompt when the cancel throws a retryable SessionNotActiveError", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(
      vi.fn().mockRejectedValue(new SessionNotActiveError({ retryable: true })),
    );

    await clickCancel(runtime);

    expect(fetchMock).toHaveBeenCalledWith(...deletePost);
  });

  it("removes the prompt when the cancel cannot be dispatched", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn().mockRejectedValue(new Error("runtime unavailable")));

    await clickCancel(runtime);

    expect(fetchMock).toHaveBeenCalledWith(...deletePost);
  });

  it("logs when Slack refuses the delete", async () => {
    const fetchMock = stubFetch(new Response("expired_url", { status: 404 }));
    const runtime = createRuntime(vi.fn().mockResolvedValue({ status: "no_active_turn" }));

    await clickCancel(runtime);

    expect(fetchMock).toHaveBeenCalledWith(...deletePost);
    expect(logger.warn).toHaveBeenCalledWith("Slack refused to change the sign-in prompt", {
      body: "expired_url",
      status: 404,
    });
  });
});

function connectClick(userId: string, value?: string): Record<string, unknown> {
  return {
    actions: [
      {
        action_id: SIGN_IN_CONNECT_ACTION_ID,
        url: "https://connect.example.com/authorize/sca_abc",
        value:
          value ??
          JSON.stringify({
            channelId: "C1",
            interactionId: "int_linear",
            name: "linear",
            threadTs: "1.2",
            userId: "U_ALICE",
          }),
      },
    ],
    response_url: RESPONSE_URL,
    type: "block_actions",
    user: { id: userId },
  };
}

async function clickConnect(runtime: Runtime, click: Record<string, unknown>): Promise<void> {
  const { from } = createChannelOperations<SlackChannelState>({
    adapter: { kind: "slack" },
    channelName: "slack",
    runtime,
  });
  const tasks: Promise<unknown>[] = [];
  expect(dispatchSignInConnect(click, { from, waitUntil: (task) => tasks.push(task) })).toBe(true);
  await Promise.all(tasks);
}

describe("dispatchSignInConnect", () => {
  it("leaves the prompt on screen and records its response_url", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(
      vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
    );

    await clickConnect(runtime, connectClick("U_ALICE"));

    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: {
        deliveryId: expect.any(String),
        kind: "channel-state",
        state: { signInPrompts: { int_linear: { responseUrl: RESPONSE_URL } } },
      },
      continuationToken: expect.stringContaining("C1"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes a prompt that carries no session at once", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn());

    await clickConnect(runtime, connectClick("U_ALICE", ""));

    expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(...deletePost);
  });

  it("ignores a click from anyone but the person the prompt was shown to", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn());

    await clickConnect(runtime, connectClick("U_MALLORY"));

    expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the prompt on screen when the session cannot record it", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn().mockResolvedValue({ status: "no_active_session" }));

    await clickConnect(runtime, connectClick("U_ALICE"));

    expect(logger.warn).toHaveBeenCalledWith(
      "failed to record the sign-in prompt for removal",
      expect.objectContaining({ name: "linear" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves every other interaction alone", () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn());
    const { from } = createChannelOperations<SlackChannelState>({
      adapter: { kind: "slack" },
      channelName: "slack",
      runtime,
    });
    const waitUntil = vi.fn();
    expect(dispatchSignInConnect(cancelClick(), { from, waitUntil })).toBe(false);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

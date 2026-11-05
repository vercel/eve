import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import type { Runtime } from "#channel/types.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";
import {
  dispatchSignInCancel,
  SIGN_IN_CANCEL_ACTION_ID,
} from "#public/channels/slack/sign-in-cancel.js";

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

  it("removes the prompt when the held turn has already ended", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn().mockResolvedValue({ status: "no_active_turn" }));

    await clickCancel(runtime);

    expect(fetchMock).toHaveBeenCalledWith(...deletePost);
  });

  it("keeps the prompt when the session is still starting", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(
      vi.fn().mockResolvedValue({ retryable: true, status: "session_not_ready" }),
    );

    await clickCancel(runtime);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the prompt when the cancel cannot be dispatched", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime(vi.fn().mockRejectedValue(new Error("runtime unavailable")));

    await clickCancel(runtime);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settles when Slack refuses the delete", async () => {
    const fetchMock = stubFetch(new Response("expired_url", { status: 404 }));
    const runtime = createRuntime(vi.fn().mockResolvedValue({ status: "no_active_turn" }));

    await expect(clickCancel(runtime)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(...deletePost);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelOperations } from "#channel/channel-operations.js";
import type { Runtime } from "#channel/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import {
  buildAuthEphemeralBlocks,
  SIGN_IN_CONNECT_ACTION_ID,
} from "#public/channels/slack/connections.js";
import { dispatchSignInConnect } from "#public/channels/slack/sign-in-connect.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";

const RESPONSE_URL = "https://hooks.slack.com/actions/T1/1/abc";
const turnId = "turn_1";
const target = { channelId: "C1", interactionId: "sign-in-1", threadTs: "1.2" };

const waitingOnLinear: SessionEvent[] = [
  { data: {}, type: "session.started" },
  { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
  { data: { cause: { deliveryId: "d_1" }, follows: null, turnId }, type: "turn.started" },
  {
    data: {
      audience: { principalIds: ["slack:T1:U1"] },
      interactionId: "sign-in-1",
      request: {
        kind: "sign-in",
        prompt: "Sign in to Linear to continue.",
        signIn: { name: "linear", url: "https://linear.test/authorize" },
      },
      subject: { turnId },
    },
    type: "interaction.opened",
  } as SessionEvent,
];

function settled(outcome: "accepted" | "failed", interactionId = "sign-in-1"): SessionEvent {
  return { data: { interactionId, outcome }, type: "interaction.settled" } as SessionEvent;
}

function createRuntime(events: readonly SessionEvent[]): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn(),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(async () => ReadableStream.from(events) as never),
    getLineStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn().mockResolvedValue({ sessionId: "sess_1" }),
  };
}

/** The click Slack sends for the prompt's Connect button, read back from the button it posted. */
function connectClick(): Record<string, unknown> {
  const blocks = buildAuthEphemeralBlocks({
    connect: target,
    displayName: "Linear",
    url: "https://linear.test/authorize",
  }) as { type: string; elements?: Record<string, unknown>[] }[];
  const button = blocks.find((block) => block.type === "actions")!.elements![0]!;
  return {
    actions: [{ action_id: button.action_id, type: "button", value: button.value }],
    response_url: RESPONSE_URL,
    type: "block_actions",
  };
}

async function clickConnect(runtime: Runtime, click = connectClick()): Promise<boolean> {
  const { resolveSession } = createChannelOperations<SlackChannelState>({
    adapter: { kind: "slack" },
    channelName: "slack",
    runtime,
  });
  const tasks: Promise<unknown>[] = [];
  const handled = dispatchSignInConnect(click, {
    resolveSession,
    waitUntil: (task) => tasks.push(task),
  });
  await Promise.all(tasks);
  return handled;
}

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("dispatchSignInConnect", () => {
  it("names its Connect button so the click reaches eve", () => {
    expect(connectClick().actions).toEqual([
      { action_id: SIGN_IN_CONNECT_ACTION_ID, type: "button", value: JSON.stringify(target) },
    ]);
  });

  it("shows the connected outcome in the prompt once the sign-in settles accepted", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime([...waitingOnLinear, settled("accepted")]);

    expect(await clickConnect(runtime)).toBe(true);

    expect(runtime.getEventStream).toHaveBeenCalledWith(
      "sess_1",
      expect.objectContaining({ startIndex: -500 }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(RESPONSE_URL, {
      body: JSON.stringify({ replace_original: true, text: ":white_check_mark: Linear connected" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });

  it("shows a failed sign-in as failed", async () => {
    const fetchMock = stubFetch();
    await clickConnect(createRuntime([...waitingOnLinear, settled("failed")]));

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      replace_original: true,
      text: ":x: Linear authorization failed",
    });
  });

  it("leaves the prompt alone while the sign-in stays open or another one settles", async () => {
    const fetchMock = stubFetch();
    await clickConnect(createRuntime([...waitingOnLinear, settled("accepted", "sign-in-2")]));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the prompt alone when no session owns the thread", async () => {
    const fetchMock = stubFetch();
    const runtime = createRuntime([]);
    vi.mocked(runtime.resolveContinuation).mockResolvedValue(undefined);

    await clickConnect(runtime);

    expect(runtime.getEventStream).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores clicks on other buttons", async () => {
    const runtime = createRuntime([]);
    const handled = await clickConnect(runtime, {
      actions: [{ action_id: "eve_sign_in:cancel", value: "{}" }],
      response_url: RESPONSE_URL,
      type: "block_actions",
    });

    expect(handled).toBe(false);
    expect(runtime.resolveContinuation).not.toHaveBeenCalled();
  });
});

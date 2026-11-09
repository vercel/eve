import { describe, expect, it, vi } from "vitest";

import { setChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { snapshotOf } from "#protocol/session-projection/session-view.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionEvent } from "#protocol/session-event.js";

import { moveSessionOnCallSettled, moveToCodeChannel } from "./move-to-code-channel.js";
import { slackChannel } from "./slackChannel.js";

const scope = { runId: "run_0", turnId: "turn_0" };
const slack = slackChannel({ codeChannels: true });
const slackKind = "channel:slack";
setChannelInstrumentationKind(slack as never, slackKind);

function harness(input: {
  readonly kind?: "tool" | "agent";
  readonly output: unknown;
  readonly create?: Record<string, unknown>;
}) {
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const startTyping = vi.fn(async () => {});
  const post = vi.fn(async () => ({ id: "posted" }));
  const alias = vi.fn();
  const release = vi.fn();
  const channel = {
    continuation: { alias, release, token: "C1:1.0" },
    slack: {
      async request(method: string, body: Record<string, unknown>) {
        requests.push({ body, method });
        if (method === "conversations.info") return { channel: {}, ok: true };
        if (method === "agents.conversations.create")
          return input.create ?? { channel_id: "C2", ok: true };
        return { ok: true };
      },
    },
    state: {
      audience: "public",
      channelId: "C1",
      taskCards: { turn_0: { ts: "card" } },
      threadTs: "1.0",
      triggeringMessageTs: "1.5",
    } as Record<string, unknown>,
    thread: { post, startTyping },
  };
  const view = emptySessionView();
  const facts: SessionEvent[] = [
    { data: {}, type: "session.started" },
    {
      data: {
        callId: "c_1",
        capability: { kind: input.kind ?? "tool", name: "move" },
        input: {},
        owner: { runId: "run_0" },
      },
      scope,
      type: "call.requested",
    },
  ];
  foldLine(view, { at: "2026-11-09T00:00:00.000Z", facts }, 0, { retention: "operational" });
  const settled = {
    data: { callId: "c_1", outcome: "completed", output: input.output },
    scope,
    type: "call.settled",
  } as const;
  const run = () =>
    moveSessionOnCallSettled(
      settled as never,
      {
        channel,
        session: { auth: { current: { principalId: "U1" } } },
        view: snapshotOf(view),
      } as never,
    );
  return { alias, channel, post, release, requests, run, startTyping };
}

describe("moveToCodeChannel", () => {
  it("asks the Slack channel to move a thread session", () => {
    expect(
      moveToCodeChannel(
        { channel: { kind: slackKind, metadata: { channelId: "C1", threadTs: "1.0" } } } as never,
        slack,
        { name: "Fix the flaky test" },
      ),
    ).toEqual({ eveSlackMoveToCodeChannel: { name: "Fix the flaky test" }, status: "moving" });
  });

  it("is unavailable in a code channel or outside a Slack thread", () => {
    const call = (channel: unknown) => moveToCodeChannel({ channel } as never, slack);
    expect(call({ kind: slackKind, metadata: { channelId: "C2", codeChannel: true } })).toEqual({
      reason: "This conversation is already a code channel.",
      status: "unavailable",
    });
    expect(call({ kind: "channel:http", metadata: {} })).toMatchObject({ status: "unavailable" });
  });
});

describe("moveSessionOnCallSettled", () => {
  it("opens the code channel and moves the session there, releasing the thread", async () => {
    const harnessed = harness({ output: { eveSlackMoveToCodeChannel: { name: "Fix" } } });
    await harnessed.run();

    expect(
      harnessed.requests.find((r) => r.method === "agents.conversations.create")?.body,
    ).toEqual(
      expect.objectContaining({ name: "Fix", origin_channel_id: "C1", origin_message_ts: "1.5" }),
    );
    expect(harnessed.startTyping).toHaveBeenCalledWith();
    expect(harnessed.alias).toHaveBeenCalledWith("code:C2");
    expect(harnessed.release).toHaveBeenCalledWith("C1:1.0");
    expect(harnessed.alias.mock.invocationCallOrder[0]).toBeLessThan(
      harnessed.release.mock.invocationCallOrder[0]!,
    );
    expect(harnessed.channel.state).toMatchObject({
      audience: "public",
      channelId: "C2",
      codeChannel: true,
      replyThreadTs: null,
      taskCards: {},
      threadTs: null,
    });
    expect(harnessed.requests.at(-1)).toEqual({
      body: { channel_id: "C2", status: "processing" },
      method: "agents.sessions.setStatus",
    });
  });

  it("ignores ordinary tool output and output from subagents", async () => {
    const ordinary = harness({ output: { status: "done" } });
    await ordinary.run();
    const subagent = harness({ kind: "agent", output: { eveSlackMoveToCodeChannel: {} } });
    await subagent.run();

    for (const { alias, channel, requests } of [ordinary, subagent]) {
      expect(requests).toEqual([]);
      expect(alias).not.toHaveBeenCalled();
      expect(channel.state.channelId).toBe("C1");
    }
  });

  it("stays in the thread and says so when Slack refuses permanently", async () => {
    const refused = harness({
      create: { error: "restricted_action", ok: false },
      output: { eveSlackMoveToCodeChannel: { name: "" } },
    });
    await refused.run();

    expect(refused.alias).not.toHaveBeenCalled();
    expect(refused.release).not.toHaveBeenCalled();
    expect(refused.channel.state.channelId).toBe("C1");
    expect(refused.post).toHaveBeenCalledWith(expect.stringContaining("restricted_action"));
  });
});

import { describe, expect, it, vi } from "vitest";

import { setChannelInstrumentationKind } from "#channel/compiled-channel.js";
import { snapshotOf } from "#protocol/session-projection/session-view.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionEvent } from "#protocol/session-event.js";

import type { SlackApiResponse } from "./api.js";

import {
  moveSessionOnCallSettled,
  moveToCodeChannel,
  setSlackCodeChannelMove,
} from "./move-to-code-channel.js";
import { slackChannel, type SlackChannelContext } from "./slackChannel.js";

const scope = { runId: "run_0", turnId: "turn_0" };
const slackKind = "channel:slack";
const thread = { channelId: "C1", installationTeamId: "T0", threadTs: "1.0" };

function slackRequests(create: Record<string, unknown> = { channel_id: "C2", ok: true }) {
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const request = async (method: string, body: unknown): Promise<SlackApiResponse> => {
    requests.push({ body: body as Record<string, unknown>, method });
    if (method === "conversations.info") return { channel: {}, ok: true };
    if (method === "agents.conversations.create") return create as SlackApiResponse;
    return { ok: true };
  };
  return { request, requests };
}

function moveChannel(request: ReturnType<typeof slackRequests>["request"]) {
  const slack = slackChannel({ codeChannels: true });
  setChannelInstrumentationKind(slack as never, slackKind);
  const workspaces: unknown[] = [];
  setSlackCodeChannelMove(slack, {
    moveTool: "move_to_code_channel",
    request: (workspace) => {
      workspaces.push(workspace);
      return request;
    },
  });
  return { slack, workspaces };
}

function toolContext(metadata: Record<string, unknown>, toolName = "move_to_code_channel") {
  return {
    channel: { kind: slackKind, metadata },
    session: { auth: { current: { principalId: "U1" } } },
    toolName,
  } as never;
}

describe("moveToCodeChannel", () => {
  it("opens the code channel from the triggering message with the channel's credentials", async () => {
    const { request, requests } = slackRequests();
    const { slack, workspaces } = moveChannel(request);

    const result = await moveToCodeChannel(
      toolContext({ ...thread, triggeringMessageTs: "1.5" }),
      slack,
      { name: "Fix the flaky test" },
    );

    expect(result).toEqual({
      channelId: "C2",
      eveSlackMovedToCodeChannel: { channelId: "C2", isPrivate: false },
      status: "moved",
    });
    expect(workspaces).toEqual([{ installationTeamId: "T0", teamId: undefined }]);
    expect(requests.find((r) => r.method === "agents.conversations.create")?.body).toEqual(
      expect.objectContaining({
        name: "Fix the flaky test",
        origin_channel_id: "C1",
        origin_message_ts: "1.5",
      }),
    );
  });

  it("throws Slack's error, so the tool call fails and the session stays in the thread", async () => {
    const { request } = slackRequests({ error: "restricted_action", ok: false });
    const { slack } = moveChannel(request);

    await expect(moveToCodeChannel(toolContext(thread), slack)).rejects.toThrow(
      "restricted_action",
    );
  });

  it("is unavailable from another tool, in a code channel, or outside a Slack thread", async () => {
    const { request, requests } = slackRequests();
    const { slack } = moveChannel(request);
    const unconfigured = slackChannel({ codeChannels: true });
    setChannelInstrumentationKind(unconfigured as never, slackKind);

    await expect(
      moveToCodeChannel(toolContext(thread, "other_tool"), slack),
    ).resolves.toMatchObject({
      reason: expect.stringContaining("other_tool"),
      status: "unavailable",
    });
    await expect(moveToCodeChannel(toolContext(thread), unconfigured)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(
      moveToCodeChannel(toolContext({ channelId: "C2", codeChannel: true }), slack),
    ).resolves.toEqual({
      reason: "This conversation is already a code channel.",
      status: "unavailable",
    });
    await expect(
      moveToCodeChannel(
        { ...(toolContext(thread) as object), channel: { kind: "channel:http" } } as never,
        slack,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(requests).toEqual([]);
  });
});

function harness(input: {
  readonly name?: string;
  readonly kind?: "tool" | "agent";
  readonly output: unknown;
}) {
  const { request, requests } = slackRequests();
  const startTyping = vi.fn(async () => {});
  const alias = vi.fn();
  const release = vi.fn();
  const channel = {
    continuation: { alias, release, token: "C1:1.0" },
    slack: { request },
    state: {
      audience: "public",
      channelId: "C1",
      taskCards: { turn_0: { ts: "card" } },
      threadTs: "1.0",
    } as Record<string, unknown>,
    thread: { startTyping },
  };
  const view = emptySessionView();
  const facts: SessionEvent[] = [
    { data: {}, type: "session.started" },
    {
      data: {
        callId: "c_1",
        capability: { kind: input.kind ?? "tool", name: input.name ?? "move_to_code_channel" },
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
      { channel, session: { auth: { current: null } }, view: snapshotOf(view) } as never,
      "move_to_code_channel",
    );
  return { alias, channel, release, requests, run, startTyping };
}

const movedOutput = {
  channelId: "C2",
  eveSlackMovedToCodeChannel: { channelId: "C2", isPrivate: true },
  status: "moved",
};

describe("moveSessionOnCallSettled", () => {
  it("moves the session into the code channel the tool opened, releasing the thread", async () => {
    const moved = harness({ output: movedOutput });
    await moved.run();

    expect(moved.startTyping).toHaveBeenCalledWith();
    expect(moved.alias).toHaveBeenCalledWith("code:C2");
    expect(moved.release).toHaveBeenCalledWith("C1:1.0");
    expect(moved.alias.mock.invocationCallOrder[0]).toBeLessThan(
      moved.release.mock.invocationCallOrder[0]!,
    );
    expect(moved.channel.state).toMatchObject({
      audience: "private",
      channelId: "C2",
      codeChannel: true,
      replyThreadTs: null,
      taskCards: {},
      threadTs: null,
    });
    expect(moved.requests).toEqual([
      { body: { channel_id: "C2", status: "processing" }, method: "agents.sessions.setStatus" },
    ]);
  });

  it("ignores the same output from any tool but the named move tool", async () => {
    const forged = [
      harness({ name: "remote__lookup", output: movedOutput }),
      harness({ kind: "agent", name: "move_to_code_channel", output: movedOutput }),
      harness({ output: { reason: "no", status: "unavailable" } }),
    ];
    for (const attempt of forged) await attempt.run();

    for (const { alias, channel, requests } of forged) {
      expect(requests).toEqual([]);
      expect(alias).not.toHaveBeenCalled();
      expect(channel.state.channelId).toBe("C1");
    }
  });
});

describe("the Slack binding after a move", () => {
  it("follows the session into the code channel within the same step", () => {
    const slack = slackChannel({ codeChannels: true, credentials: { botToken: "xoxb-test" } });
    const state = { channelId: "C1", threadTs: "1.0" } as Record<string, unknown>;
    const { adapter } = slack as never as {
      readonly adapter: { createAdapterContext(base: unknown): SlackChannelContext };
    };
    const channel = adapter.createAdapterContext({
      ctx: undefined,
      session: { auth: { current: null, initiator: null }, id: "s_1" },
      state,
    });
    expect(channel.slack).toMatchObject({ channelId: "C1", codeChannel: false });

    Object.assign(state, { channelId: "C2", codeChannel: true, threadTs: null });

    expect(channel.slack).toMatchObject({ channelId: "C2", codeChannel: true });
    expect(typeof channel.thread.post).toBe("function");
  });
});

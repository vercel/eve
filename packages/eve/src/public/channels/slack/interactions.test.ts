import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";
import { createChannelOperations } from "#channel/channel-operations.js";
import type { Runtime } from "#channel/types.js";
import {
  handleInteractionPost,
  parseBlockActionsPayload,
  parseShortcutPayload,
} from "#public/channels/slack/interactions.js";
import { SIGN_IN_CONNECT_ACTION_ID } from "#public/channels/slack/sign-in-cancel.js";
import type { SlackChannelConfig, SlackChannelState } from "#public/channels/slack/slackChannel.js";

function makePayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    actions: [{ action_id: "test_action", value: "test_value" }],
    channel: { id: "C0123456789" },
    message: { ts: "1700000000.000000", thread_ts: "1700000000.000000", blocks: [] },
    team: { id: "T0123456789" },
    user: {
      id: "U0123456789",
      username: "jane.doe",
      name: "jane.doe",
      team_id: "T0123456789",
    },
    ...overrides,
  };
}

describe("parseShortcutPayload", () => {
  it("normalizes a message shortcut", () => {
    expect(
      parseShortcutPayload({
        type: "message_action",
        callback_id: "summarize_message",
        trigger_id: "trigger-123",
        team: { id: "T_INSTALLATION" },
        user: { id: "U01", username: "ada", team_id: "T_ACTOR" },
        channel: { id: "C01" },
        message: {
          text: "Please summarize this",
          ts: "1700000000.000200",
          thread_ts: "1700000000.000100",
          user: "U02",
        },
        response_url: "https://hooks.slack.com/actions/example",
      }),
    ).toEqual({
      type: "message_action",
      callbackId: "summarize_message",
      triggerId: "trigger-123",
      teamId: "T_ACTOR",
      user: { id: "U01", username: "ada", name: undefined },
      channelId: "C01",
      message: {
        text: "Please summarize this",
        ts: "1700000000.000200",
        threadTs: "1700000000.000100",
        userId: "U02",
      },
      responseUrl: "https://hooks.slack.com/actions/example",
    });
  });

  it("normalizes a global shortcut without message fields", () => {
    expect(
      parseShortcutPayload({
        type: "shortcut",
        callback_id: "new_request",
        trigger_id: "trigger-456",
        team: { id: "T01" },
        user: { id: "U01", name: "ada" },
      }),
    ).toEqual({
      type: "shortcut",
      callbackId: "new_request",
      triggerId: "trigger-456",
      teamId: "T01",
      user: { id: "U01", username: undefined, name: "ada" },
    });
  });

  it("rejects malformed and unrelated interaction payloads", () => {
    expect(parseShortcutPayload({ type: "block_actions" })).toBeNull();
    expect(parseShortcutPayload({ type: "shortcut", callback_id: "missing-fields" })).toBeNull();
  });
});

describe("parseBlockActionsPayload", () => {
  it("exposes the actor as a nested user object on each parsed action", () => {
    const parsed = parseBlockActionsPayload(
      makePayload({
        actions: [
          { action_id: "approve", value: "v1" },
          { action_id: "dismiss", value: "v2" },
        ],
      }),
    );
    expect(parsed?.actions).toHaveLength(2);
    for (const action of parsed?.actions ?? []) {
      expect(action.user).toEqual({
        id: "U0123456789",
        username: "jane.doe",
        name: "jane.doe",
      });
    }
  });

  it("separates the installation and actor workspaces in block_actions", () => {
    const body = new URLSearchParams({
      payload: JSON.stringify(
        makePayload({
          type: "block_actions",
          team: { id: "T_INSTALLATION" },
          user: {
            id: "U0123456789",
            username: "jane.doe",
            name: "jane.doe",
            team_id: "T_ACTOR",
          },
          actions: [
            {
              action_id: "priority",
              type: "static_select",
              selected_option: {
                value: "high",
                text: { type: "plain_text", text: "High" },
              },
            },
          ],
          message: {
            ts: "1700000000.000200",
            thread_ts: "1700000000.000100",
            blocks: [{ type: "section", text: { type: "mrkdwn", text: "Pick one" } }],
          },
        }),
      ),
    }).toString();
    const payload = parseSlackWebhookBody(body, {
      contentType: "application/x-www-form-urlencoded",
    });
    expect(payload.kind).toBe("block_actions");
    if (payload.kind !== "block_actions") throw new Error("expected block_actions");

    const parsed = parseBlockActionsPayload(payload);

    expect(parsed).toMatchObject({
      channelId: "C0123456789",
      installationTeamId: "T_INSTALLATION",
      threadTs: "1700000000.000100",
      teamId: "T_ACTOR",
    });
    expect(parsed?.messageBlocks).toHaveLength(1);
    expect(parsed?.actions[0]).toMatchObject({
      actionId: "priority",
      label: "High",
      messageTs: "1700000000.000200",
      selectedOptionValue: "high",
      user: {
        id: "U0123456789",
        username: "jane.doe",
        name: "jane.doe",
      },
    });
  });
});

describe("handleInteractionPost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records a sign-in prompt's Connect click in its session instead of onInteraction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const dispatchContinuation = vi
      .fn()
      .mockResolvedValue({ sessionId: "s_1", status: "accepted" });
    const runtime: Runtime = {
      createSession: vi.fn(),
      dispatchContinuation,
      dispatchSession: vi.fn(),
      getEventStream: vi.fn(),
      getLineStream: vi.fn(),
      getStreamTailIndex: vi.fn(),
      resolveContinuation: vi.fn(),
    };
    const { from, resolveSession } = createChannelOperations<SlackChannelState>({
      adapter: { kind: "slack" },
      channelName: "slack",
      runtime,
    });
    const onInteraction = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const payload = makePayload({
      actions: [
        {
          action_id: SIGN_IN_CONNECT_ACTION_ID,
          type: "button",
          url: "https://idp.example/authorize",
          value: JSON.stringify({
            channelId: "C0123456789",
            displayName: "Linear",
            name: "linear",
            threadTs: "1700000000.000000",
            userId: "U0123456789",
          }),
        },
      ],
      container: { type: "message", is_ephemeral: true },
      message: undefined,
      response_url: "https://hooks.slack.com/actions/T1/1/abc",
      type: "block_actions",
    });

    const response = await handleInteractionPost(
      new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
      { from, resolveSession, waitUntil: (task) => tasks.push(task) },
      {
        api: undefined,
        config: { onInteraction } as unknown as SlackChannelConfig,
        onAnswers: vi.fn(),
      },
    );
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(onInteraction).not.toHaveBeenCalled();
    expect(dispatchContinuation).toHaveBeenCalledWith({
      command: {
        deliveryId: expect.any(String),
        kind: "channel-state",
        state: { signInPromptResponseUrls: { linear: "https://hooks.slack.com/actions/T1/1/abc" } },
      },
      continuationToken: expect.stringContaining("C0123456789"),
    });
    expect(fetchMock).toHaveBeenCalledWith("https://hooks.slack.com/actions/T1/1/abc", {
      body: JSON.stringify({ replace_original: true, text: "Waiting for Linear..." }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });
});

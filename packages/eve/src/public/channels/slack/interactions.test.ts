import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";
import {
  handleInteractionPost,
  parseBlockActionsPayload,
  parseShortcutPayload,
} from "#public/channels/slack/interactions.js";
import {
  buildChildSessionLimitGroupPost,
  CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID,
} from "#public/channels/slack/child-session-limits.js";

afterEach(() => vi.unstubAllGlobals());

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

describe("handleInteractionPost child session-limit groups", () => {
  it("submits every snapshotted child response and closes that group revision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const post = buildChildSessionLimitGroupPost({
      groupId: "parent-turn-1",
      requestIds: ["limit-1", "limit-2"],
      revision: 2,
    });
    const card = post.blocks[0] as { actions: Array<{ value: string }> };
    const respond = vi.fn().mockResolvedValue(undefined);
    const pending: Promise<unknown>[] = [];
    const rawBody = new URLSearchParams({
      payload: JSON.stringify(
        makePayload({
          actions: [
            {
              action_id: CHILD_SESSION_LIMIT_APPROVE_ALL_ACTION_ID,
              text: { type: "plain_text", text: "Approve all" },
              type: "button",
              value: card.actions[0]!.value,
            },
          ],
          message: {
            blocks: post.blocks,
            thread_ts: "1700000000.000000",
            ts: "1700000000.000001",
          },
          type: "block_actions",
        }),
      ),
    }).toString();

    await handleInteractionPost(
      rawBody,
      {
        from: vi.fn().mockReturnValue({ respond }),
        resolveSession: vi.fn(),
        waitUntil: (task: Promise<unknown>) => pending.push(task),
      } as never,
      {
        config: { credentials: { botToken: "xoxb-test" } },
        onInputResponse: vi.fn().mockResolvedValue({ auth: null }),
      } as never,
    );
    await Promise.all(pending);

    expect(respond).toHaveBeenCalledWith(
      [
        { optionId: "continue", requestId: "limit-1" },
        { optionId: "continue", requestId: "limit-2" },
      ],
      {
        auth: null,
        state: {
          childSessionLimitGroupSubmissions: {
            "parent-turn-1": {
              messageTs: "1700000000.000001",
              optionId: "continue",
              revision: 2,
            },
          },
          submittedChildSessionLimitGroupRevisions: { "parent-turn-1": 2 },
        },
      },
    );
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

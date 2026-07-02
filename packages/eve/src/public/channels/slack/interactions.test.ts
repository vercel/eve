import { describe, expect, it } from "vitest";

import { parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";
import { parseBlockActionsPayload } from "#public/channels/slack/interactions.js";

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

  it("accepts the shared Slack webhook block_actions payload", () => {
    const body = new URLSearchParams({
      payload: JSON.stringify(
        makePayload({
          type: "block_actions",
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
      threadTs: "1700000000.000100",
      teamId: "T0123456789",
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

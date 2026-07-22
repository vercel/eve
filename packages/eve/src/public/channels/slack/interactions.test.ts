import { describe, expect, it } from "vitest";

import { parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";
import {
  handleInteractionPost,
  parseBlockActionsPayload,
} from "#public/channels/slack/interactions.js";
import type {
  SlackChannelConfig,
  SlackViewSubmission,
} from "#public/channels/slack/slackChannel.js";

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

describe("triggerId propagation", () => {
  it("copies the payload trigger_id onto every parsed action", () => {
    const parsed = parseBlockActionsPayload(
      makePayload({
        trigger_id: "13345224609.738474920.8088930838d88f008e0",
        actions: [
          { action_id: "approve", value: "v1" },
          { action_id: "dismiss", value: "v2" },
        ],
      }),
    );
    expect(parsed?.actions).toHaveLength(2);
    for (const action of parsed?.actions ?? []) {
      expect(action.triggerId).toBe("13345224609.738474920.8088930838d88f008e0");
    }
  });

  it("carries trigger_id through the shared webhook parser branch", () => {
    const body = new URLSearchParams({
      payload: JSON.stringify(
        makePayload({
          type: "block_actions",
          trigger_id: "999.888.777",
        }),
      ),
    }).toString();
    const payload = parseSlackWebhookBody(body, {
      contentType: "application/x-www-form-urlencoded",
    });
    if (payload.kind !== "block_actions") throw new Error("expected block_actions");
    const parsed = parseBlockActionsPayload(payload);
    expect(parsed?.actions[0]?.triggerId).toBe("999.888.777");
  });
});

function viewSubmissionBody(overrides: Record<string, unknown>): string {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "view_submission",
      team: { id: "T0123456789" },
      user: { id: "U0123456789", username: "jane.doe", name: "jane.doe" },
      view: {
        id: "V0123456789",
        callback_id: "my-app-modal",
        private_metadata: JSON.stringify({ suggestionId: "cold:C1:2.0" }),
        state: {
          values: {
            note_block: {
              note_input: { type: "plain_text_input", value: "right goal, wrong channel" },
            },
          },
        },
      },
      ...overrides,
    }),
  }).toString();
}

describe("handleInteractionPost view_submission forwarding", () => {
  const ctx = {
    send: (() => Promise.resolve({})) as never,
    waitUntil: (task: Promise<unknown>) => {
      void task;
    },
  };

  it("forwards foreign-callback view submissions to onViewSubmission", async () => {
    const received: SlackViewSubmission[] = [];
    const config = {
      onViewSubmission(view: SlackViewSubmission) {
        received.push(view);
      },
    } as SlackChannelConfig;

    const response = await handleInteractionPost(viewSubmissionBody({}), ctx, { config });
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      callbackId: "my-app-modal",
      privateMetadata: JSON.stringify({ suggestionId: "cold:C1:2.0" }),
      user: { id: "U0123456789", username: "jane.doe" },
      teamId: "T0123456789",
    });
    expect(received[0]?.values).toContainEqual(
      expect.objectContaining({
        blockId: "note_block",
        actionId: "note_input",
        value: "right goal, wrong channel",
      }),
    );
  });

  it("never forwards the framework's own HITL freeform modal", async () => {
    const received: SlackViewSubmission[] = [];
    const config = {
      onViewSubmission(view: SlackViewSubmission) {
        received.push(view);
      },
    } as SlackChannelConfig;

    const body = viewSubmissionBody({
      view: {
        id: "V0123456789",
        callback_id: "eve_input_freeform_submit",
        private_metadata: "{}",
        state: { values: {} },
      },
    });
    const response = await handleInteractionPost(body, ctx, { config });
    expect(response.status).toBe(200);
    expect(received).toHaveLength(0);
  });

  it("acks foreign view submissions without a handler configured", async () => {
    const response = await handleInteractionPost(viewSubmissionBody({}), ctx, {
      config: {} as SlackChannelConfig,
    });
    expect(response.status).toBe(200);
  });
});

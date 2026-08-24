import { describe, expect, it } from "vitest";

import { parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";
import {
  parseAppMentionEvent,
  parseDirectMessageEvent,
  parseMessageEvent,
  parseSlackEventEnvelope,
  slackMessageFromWebhookPayload,
} from "#public/channels/slack/inbound.js";

describe("parseSlackEventEnvelope", () => {
  it("preserves an arbitrary Events API payload and its delivery envelope", () => {
    const envelope = parseSlackEventEnvelope(
      JSON.stringify({
        api_app_id: "A01",
        event: {
          item: { channel: "C01", ts: "1700000000.000100", type: "message" },
          reaction: "eyes",
          type: "reaction_added",
          user: "U01",
        },
        event_id: "Ev01",
        event_time: 1_700_000_000,
        team_id: "T01",
        type: "event_callback",
      }),
    );

    expect(envelope).toMatchObject({
      api_app_id: "A01",
      event: {
        item: { channel: "C01", ts: "1700000000.000100", type: "message" },
        reaction: "eyes",
        type: "reaction_added",
        user: "U01",
      },
      event_id: "Ev01",
      event_time: 1_700_000_000,
      team_id: "T01",
    });
  });

  it("returns null for non-event callbacks and missing event types", () => {
    expect(
      parseSlackEventEnvelope(JSON.stringify({ challenge: "abc", type: "url_verification" })),
    ).toBeNull();
    expect(
      parseSlackEventEnvelope(JSON.stringify({ event: { user: "U01" }, type: "event_callback" })),
    ).toBeNull();
  });

  it("throws for invalid JSON", () => {
    expect(() => parseSlackEventEnvelope("not-json")).toThrow();
  });
});

describe("parseAppMentionEvent", () => {
  it("returns a SlackMessage with mrkdwn re-rendered as GFM", () => {
    const message = parseAppMentionEvent({
      type: "event_callback",
      team_id: "T01",
      event: {
        type: "app_mention",
        user: "U01",
        text: "Hello <@U02> see <https://example.com|the docs>",
        channel: "C01",
        ts: "1700000000.000100",
      },
    });
    expect(message).not.toBeNull();
    expect(message?.channelId).toBe("C01");
    expect(message?.threadTs).toBe("1700000000.000100");
    expect(message?.teamId).toBe("T01");
    expect(message?.author).toEqual({
      userId: "U01",
      userName: undefined,
      fullName: undefined,
      isBot: false,
      isMe: false,
    });
    expect(message?.markdown).toBe("Hello @U02 see [the docs](https://example.com)");
  });

  it("returns null for non-app_mention events", () => {
    const message = parseAppMentionEvent({
      type: "event_callback",
      event: { type: "message", channel: "C01", ts: "1.0" },
    });
    expect(message).toBeNull();
  });

  it("returns null when channel or ts is missing", () => {
    const message = parseAppMentionEvent({
      type: "event_callback",
      event: { type: "app_mention", user: "U01" },
    });
    expect(message).toBeNull();
  });

  it("uses thread_ts when present, falls back to ts", () => {
    const reply = parseAppMentionEvent({
      type: "event_callback",
      event: {
        type: "app_mention",
        user: "U01",
        text: "hi",
        channel: "C01",
        ts: "1700000000.000200",
        thread_ts: "1700000000.000100",
      },
    });
    expect(reply?.threadTs).toBe("1700000000.000100");
    expect(reply?.ts).toBe("1700000000.000200");
  });

  it("flags bot authors via bot_id", () => {
    const message = parseAppMentionEvent({
      type: "event_callback",
      event: {
        type: "app_mention",
        user: "U_BOT",
        bot_id: "B01",
        text: "hi",
        channel: "C01",
        ts: "1.0",
      },
    });
    expect(message?.author?.isBot).toBe(true);
  });

  it("collects file attachments with inferred type", () => {
    const message = parseAppMentionEvent({
      type: "event_callback",
      event: {
        type: "app_mention",
        user: "U01",
        text: "see this",
        channel: "C01",
        ts: "1.0",
        files: [
          {
            id: "F1",
            name: "chart.png",
            mimetype: "image/png",
            url_private: "https://files.slack.com/a/chart.png",
            size: 1024,
          },
        ],
      },
    });
    expect(message?.attachments).toHaveLength(1);
    expect(message?.attachments[0]).toEqual({
      id: "F1",
      type: "image",
      url: "https://files.slack.com/a/chart.png",
      name: "chart.png",
      mimeType: "image/png",
      size: 1024,
    });
  });
});

describe("parseMessageEvent", () => {
  it("preserves bot and subtype message events for onMessage", () => {
    const bot = parseMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        bot_id: "B01",
        user: "U_BOT",
        text: "automated",
        channel: "C01",
        ts: "2.0",
      },
    });
    const subtype = parseMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_changed",
        text: "edited",
        channel: "C01",
        ts: "3.0",
      },
    });

    expect(bot?.author?.isBot).toBe(true);
    expect(subtype?.raw.subtype).toBe("message_changed");
  });
});

describe("parseDirectMessageEvent", () => {
  it("returns a SlackMessage for a plain IM message event", () => {
    const message = parseDirectMessageEvent({
      type: "event_callback",
      team_id: "T01",
      event: {
        type: "message",
        channel_type: "im",
        user: "U01",
        text: "hello bot",
        channel: "D01",
        ts: "1700000000.000100",
      },
    });
    expect(message).not.toBeNull();
    expect(message?.channelId).toBe("D01");
    expect(message?.threadTs).toBe("1700000000.000100");
    expect(message?.author?.userId).toBe("U01");
    expect(message?.markdown).toBe("hello bot");
  });

  it("returns null for app_mention events", () => {
    const result = parseDirectMessageEvent({
      type: "event_callback",
      event: {
        type: "app_mention",
        user: "U01",
        text: "hi",
        channel: "C01",
        ts: "1.0",
      },
    });
    expect(result).toBeNull();
  });

  it("returns null for non-IM message events (channel posts)", () => {
    const result = parseDirectMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "channel",
        user: "U01",
        text: "hi",
        channel: "C01",
        ts: "1.0",
      },
    });
    expect(result).toBeNull();
  });

  it("filters out messages with a subtype (edits, deletes, joins)", () => {
    const result = parseDirectMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        subtype: "message_changed",
        user: "U01",
        text: "edited",
        channel: "D01",
        ts: "1.0",
      },
    });
    expect(result).toBeNull();
  });

  it("allows file_share messages through with their attachments", () => {
    const result = parseDirectMessageEvent({
      type: "event_callback",
      team_id: "T01",
      event: {
        type: "message",
        channel_type: "im",
        subtype: "file_share",
        user: "U01",
        text: "here is a file",
        channel: "D01",
        ts: "1700000000.000100",
        files: [
          {
            id: "F01",
            mimetype: "image/png",
            url_private: "https://files.slack.com/F01/diagram.png",
            name: "diagram.png",
            size: 2048,
          },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result?.markdown).toBe("here is a file");
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments[0]?.type).toBe("image");
    expect(result?.attachments[0]?.url).toBe("https://files.slack.com/F01/diagram.png");
  });

  it("filters out bot-authored file_share messages to prevent self-loops", () => {
    const result = parseDirectMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        subtype: "file_share",
        bot_id: "B01",
        user: "U_BOT",
        channel: "D01",
        ts: "1.0",
        files: [{ id: "F01", mimetype: "image/png", url_private: "https://x/y.png" }],
      },
    });
    expect(result).toBeNull();
  });

  it("filters out bot-authored messages to prevent self-loops", () => {
    const result = parseDirectMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        bot_id: "B01",
        user: "U_BOT",
        text: "from the bot",
        channel: "D01",
        ts: "1.0",
      },
    });
    expect(result).toBeNull();
  });

  it("uses thread_ts when the DM was posted in a thread reply", () => {
    const result = parseDirectMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        user: "U01",
        text: "follow up",
        channel: "D01",
        ts: "1700000000.000200",
        thread_ts: "1700000000.000100",
      },
    });
    expect(result?.ts).toBe("1700000000.000200");
    expect(result?.threadTs).toBe("1700000000.000100");
  });

  it("returns null when channel or ts is missing", () => {
    const result = parseDirectMessageEvent({
      type: "event_callback",
      event: { type: "message", channel_type: "im", user: "U01" },
    });
    expect(result).toBeNull();
  });

  it("builds the Eve message from the shared Slack webhook payload", () => {
    const payload = parseSlackWebhookBody(
      JSON.stringify({
        type: "event_callback",
        team_id: "T01",
        event: {
          type: "message",
          channel_type: "im",
          subtype: "file_share",
          user: "U01",
          text: "here is a file",
          channel: "D01",
          ts: "1700000000.000100",
          files: [
            {
              id: "F01",
              mimetype: "image/png",
              url_private: "https://files.slack.com/F01/diagram.png",
              name: "diagram.png",
              size: 2048,
            },
          ],
        },
      }),
    );
    expect(payload.kind).toBe("direct_message");
    if (payload.kind !== "direct_message") throw new Error("expected direct_message");

    const message = slackMessageFromWebhookPayload(payload);

    expect(message?.channelId).toBe("D01");
    expect(message?.attachments).toEqual([
      {
        id: "F01",
        type: "image",
        url: "https://files.slack.com/F01/diagram.png",
        name: "diagram.png",
        mimeType: "image/png",
        size: 2048,
      },
    ]);
  });
});

describe("Block Kit inbound markdown", () => {
  it("extracts section and field text when top-level text is empty", () => {
    const message = parseMessageEvent({
      type: "event_callback",
      team_id: "T01",
      event: {
        type: "message",
        user: "U01",
        text: "",
        channel: "C01",
        ts: "1234567890.123456",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Alert:* Service latency is high",
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: "Status: Firing" },
              { type: "mrkdwn", text: "Region: us-east-1" },
            ],
          },
        ],
      },
    });

    expect(message).not.toBeNull();
    expect(message?.text).not.toBe("");
    expect(message?.markdown).toContain("Alert");
    expect(message?.markdown).toContain("Service latency is high");
    expect(message?.markdown).toContain("Status: Firing");
    expect(message?.markdown).toContain("Region: us-east-1");
  });

  it("extracts legacy attachment title, text, and fields when top-level text is empty", () => {
    const message = parseMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        user: "U01",
        text: "",
        channel: "C01",
        ts: "1234567890.123457",
        attachments: [
          {
            title: "Deploy failed",
            text: "The production deploy did not finish.",
            fields: [
              { title: "Service", value: "api", short: true },
              { title: "Commit", value: "abc123", short: true },
            ],
            footer: "CI Bot",
          },
        ],
      },
    });

    expect(message).not.toBeNull();
    expect(message?.markdown).toContain("Deploy failed");
    expect(message?.markdown).toContain("The production deploy did not finish.");
    expect(message?.markdown).toContain("Service");
    expect(message?.markdown).toContain("api");
    expect(message?.markdown).toContain("CI Bot");
  });

  it("keeps plain top-level text when there are no blocks or attachments", () => {
    const message = parseMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        user: "U01",
        text: "hello bot",
        channel: "C01",
        ts: "1234567890.123458",
      },
    });

    expect(message?.text).toBe("hello bot");
    expect(message?.markdown).toBe("hello bot");
  });

  it("does not duplicate markdown when rich_text mirrors top-level text", () => {
    const message = parseMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        user: "U01",
        text: "Status update",
        channel: "C01",
        ts: "1234567890.123459",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "Status update" }],
              },
            ],
          },
        ],
      },
    });

    expect(message?.markdown).toBe("Status update");
  });

  it("converts rich_text mentions to GFM in the extracted markdown", () => {
    const message = parseMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        bot_id: "B01",
        text: "",
        channel: "C01",
        ts: "1234567890.123462",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "cc " },
                  { type: "user", user_id: "U123" },
                  { type: "text", text: " " },
                  { type: "broadcast", range: "here" },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(message?.markdown).toBe("cc @U123 @here");
  });

  it("prefers block content over a short fallback text field", () => {
    const message = parseMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        user: "U01",
        text: "Alert",
        channel: "C01",
        ts: "1234567890.123460",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Alert:* Service latency is high in us-east-1",
            },
          },
          {
            type: "section",
            fields: [{ type: "mrkdwn", text: "Status: Firing" }],
          },
        ],
      },
    });

    expect(message?.markdown).toContain("Service latency is high in us-east-1");
    expect(message?.markdown).toContain("Status: Firing");
  });

  it("includes action block button labels as bracketed controls", () => {
    const message = parseMessageEvent({
      type: "event_callback",
      event: {
        type: "message",
        user: "U01",
        text: "",
        channel: "C01",
        ts: "1234567890.123461",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Approve this deploy?",
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Approve" },
                action_id: "approve",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Reject" },
                action_id: "reject",
              },
            ],
          },
        ],
      },
    });

    expect(message?.markdown).toContain("Approve this deploy?");
    expect(message?.markdown).toContain("[Approve] [Reject]");
  });
});

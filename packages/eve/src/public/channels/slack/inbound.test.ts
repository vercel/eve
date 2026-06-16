import { describe, expect, it } from "vitest";

import {
  formatSlackContextBlock,
  parseAppMentionEvent,
  parseDirectMessageEvent,
  type SlackInboundContext,
} from "#public/channels/slack/inbound.js";

const FULL_CONTEXT: SlackInboundContext = {
  channelId: "C01",
  fullName: "Jane Smith",
  teamId: "T01",
  threadTs: "1700000000.000001",
  userId: "U01",
  userName: "jane.smith",
};

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
});

describe("formatSlackContextBlock", () => {
  it("renders every available field between tag delimiters", () => {
    const block = formatSlackContextBlock(FULL_CONTEXT);
    expect(block.startsWith("<slack_context>")).toBe(true);
    expect(block.endsWith("</slack_context>")).toBe(true);
    expect(block).toContain("user_id: U01");
    expect(block).toContain("user_name: jane.smith");
    expect(block).toContain("full_name: Jane Smith");
    expect(block).toContain("channel_id: C01");
    expect(block).toContain("thread_ts: 1700000000.000001");
    expect(block).toContain("team_id: T01");
  });

  it("omits optional fields that are not supplied", () => {
    const block = formatSlackContextBlock({
      channelId: "C01",
      threadTs: "1.0",
      userId: "U01",
    });
    expect(block).not.toContain("user_name");
    expect(block).not.toContain("full_name");
    expect(block).not.toContain("team_id");
  });
});

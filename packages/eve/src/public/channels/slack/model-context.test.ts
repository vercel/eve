import { describe, expect, it } from "vitest";

import type { SlackThreadMessage } from "#public/channels/slack/api.js";
import {
  formatSlackInboundMessage,
  formatSlackThreadContext,
} from "#public/channels/slack/model-context.js";

function threadMessage(input: {
  readonly botId?: string;
  readonly isMe?: boolean;
  readonly text: string;
  readonly ts: string;
  readonly user?: string;
}): SlackThreadMessage {
  return {
    botId: input.botId,
    isMe: input.isMe ?? false,
    markdown: input.text,
    raw: {},
    text: input.text,
    threadTs: "1700000000.000001",
    ts: input.ts,
    user: input.user,
  };
}

describe("Slack model context", () => {
  it("keeps the triggering sender id and content in one attributed message", () => {
    const block = formatSlackInboundMessage(
      {
        channelId: "C01",
        teamId: "T01",
        threadTs: "1700000000.000001",
        userId: "U_CURRENT",
      },
      {
        markdown: "Who owns the deploy?",
        ts: "1700000000.000004",
      },
    );

    expect(block).toBe(
      [
        "<slack_message>",
        "sender_type: user",
        "sender_id: U_CURRENT",
        "channel_id: C01",
        "thread_ts: 1700000000.000001",
        "message_ts: 1700000000.000004",
        "team_id: T01",
        "<content>",
        "Who owns the deploy?",
        "</content>",
        "</slack_message>",
      ].join("\n"),
    );
  });

  it("attributes every fetched thread message by stable Slack id", () => {
    const block = formatSlackThreadContext([
      threadMessage({ text: "I own the API.", ts: "1.1", user: "U_BACKEND" }),
      threadMessage({ text: "I own the UI.", ts: "1.2", user: "U_FRONTEND" }),
      threadMessage({ botId: "B_AGENT", isMe: true, text: "Noted.", ts: "1.3" }),
    ]);

    expect(block).toContain("sender_id: U_BACKEND");
    expect(block).toContain("sender_id: U_FRONTEND");
    expect(block).toContain("sender_type: agent");
    expect(block).toContain("sender_id: B_AGENT");
    expect(block).toContain("I own the API.");
    expect(block).toContain("I own the UI.");
  });

  it("omits empty thread context", () => {
    expect(formatSlackThreadContext([])).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { formatReplyContext } from "#public/channels/chat-sdk/reply-context.js";

describe("formatReplyContext", () => {
  it("quotes the replied-to message and says when the agent sent it", () => {
    expect(formatReplyContext({ fromAgent: true, id: "m1", text: "Dinner at 7?" })).toBe(
      [
        "<reply_context>",
        "The person's next message is a reply to one of your earlier messages (message_id: m1).",
        "<quoted_message>",
        "Dinner at 7?",
        "</quoted_message>",
        "</reply_context>",
      ].join("\n"),
    );
  });

  it("still reports the reply when the quoted text is unavailable", () => {
    expect(formatReplyContext({ id: "m1", text: "  " })).toBe(
      [
        "<reply_context>",
        "The person's next message is a reply to an earlier message (message_id: m1).",
        "The replied-to message's text is not available.",
        "</reply_context>",
      ].join("\n"),
    );
  });

  it("truncates a long quote", () => {
    const context = formatReplyContext({ id: "m1", text: "a".repeat(1500) });
    expect(context).toContain(`${"a".repeat(1000)}…\n</quoted_message>`);
    expect(context).not.toContain("a".repeat(1001));
  });
});

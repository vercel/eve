import { describe, expect, it } from "vitest";

import {
  parseEmailAddress,
  parseResendReceivedEvent,
  replySubject,
  resendThreadRoot,
  stripQuotedReply,
  toResendEmail,
} from "#public/channels/resend/inbound.js";

describe("parseResendReceivedEvent", () => {
  it("reads the email ID and bare sender from email.received", () => {
    const body = JSON.stringify({
      data: { email_id: "em_1", from: "Alice <Alice@Example.com>", to: ["agent@acme.com"] },
      type: "email.received",
    });
    expect(parseResendReceivedEvent(body)).toEqual({
      address: "alice@example.com",
      emailId: "em_1",
    });
  });

  it("ignores other events and malformed bodies", () => {
    expect(parseResendReceivedEvent(JSON.stringify({ data: {}, type: "email.sent" }))).toBeNull();
    expect(parseResendReceivedEvent("not json")).toBeNull();
  });
});

describe("toResendEmail", () => {
  it("threads a reply on the first References entry and strips the quoted message", () => {
    const email = toResendEmail({
      from: "Alice <alice@example.com>",
      headers: {
        "in-reply-to": "<agent-2@acme.com>",
        references: "<root@example.com> <agent-2@acme.com>",
      },
      id: "em_2",
      message_id: "<reply-3@example.com>",
      subject: "Re: Invoice",
      text: "Thanks, that works.\n\nOn Tue, Agent wrote:\n> Here is the invoice.\n>\n> Best\n",
      to: ["agent@acme.com"],
    });

    expect(email?.references).toEqual(["<root@example.com>", "<agent-2@acme.com>"]);
    expect(resendThreadRoot(email!)).toBe("<root@example.com>");
    expect(email?.body).toBe("Thanks, that works.");
  });

  it("uses the HTML part as Markdown when there is no text part", () => {
    const email = toResendEmail({
      from: "alice@example.com",
      html: "<p>Hello <strong>agent</strong></p>",
      id: "em_1",
      message_id: "<first@example.com>",
      text: null,
    });

    expect(email?.body).toBe("Hello **agent**");
    expect(resendThreadRoot(email!)).toBe("<first@example.com>");
  });
});

describe("stripQuotedReply", () => {
  it("keeps inline quotes followed by the sender's own text", () => {
    const text = "> Can you ship Friday?\nYes, Friday works.";
    expect(stripQuotedReply(text)).toBe(text);
  });
});

describe("helpers", () => {
  it("parses addresses and builds reply subjects", () => {
    expect(parseEmailAddress("not an address")).toBeNull();
    expect(replySubject("Invoice")).toBe("Re: Invoice");
    expect(replySubject("RE: Invoice")).toBe("RE: Invoice");
  });
});

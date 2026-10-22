import { describe, expect, it } from "vitest";

import sentConnection from "../../registry/connections/sent";

const ALLOWED_TOOLS = [
  "account.get",
  "balance.get",
  "contacts.create_many",
  "contacts.delete",
  "contacts.get",
  "contacts.list",
  "contacts.message_summary",
  "dashboard.contacts",
  "dashboard.deliverability",
  "dashboard.messages_sent",
  "messages.activities.list",
  "messages.get",
  "messages.send",
  "numbers.lookup",
  "onboarding.status",
  "templates.delete",
  "templates.get",
  "templates.get_by_name",
  "templates.list",
] as const;

const APPROVAL_REQUIRED = new Set([
  "messages.send",
  "contacts.create_many",
  "contacts.delete",
  "templates.delete",
]);

describe("Sent registry connection", () => {
  it("keeps the reviewed tool and approval boundary", () => {
    expect(sentConnection.tools.allow).toEqual(ALLOWED_TOOLS);

    for (const toolName of ALLOWED_TOOLS) {
      expect(sentConnection.approval({ toolName: `sent__${toolName}` })).toBe(
        APPROVAL_REQUIRED.has(toolName) ? "user-approval" : "not-applicable",
      );
    }

    expect(sentConnection.approval({ toolName: "sent__sender_profiles.create" })).toBe(
      "not-applicable",
    );
  });
});

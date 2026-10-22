import { describe, expect, it, vi } from "vitest";

import sentConnection from "../../registry/connections/sent";

// Connect's runtime pulls in channel auth; these tests exercise only the authored approval policy.
vi.mock("@vercel/connect/eve", () => ({
  connect: () => ({ getToken: async () => ({ token: "" }) }),
}));

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
    const { tools, approval } = sentConnection;
    if (!tools || !("allow" in tools) || typeof approval !== "function") {
      throw new Error("Sent requires a tool allowlist and per-tool approval policy.");
    }
    expect(tools.allow).toEqual(ALLOWED_TOOLS);

    for (const toolName of ALLOWED_TOOLS) {
      expect(approval({ toolName: `sent__${toolName}` } as never)).toBe(
        APPROVAL_REQUIRED.has(toolName) ? "user-approval" : "not-applicable",
      );
    }

    expect(approval({ toolName: "sent__sender_profiles.create" } as never)).toBe("not-applicable");
  });
});

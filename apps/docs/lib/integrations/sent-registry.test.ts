import { describe, expect, it } from "vitest";

import sent from "../../registry/connections/sent";

const PUBLIC_TOOLS = [
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

const MUTATING_TOOLS = [
  "messages.send",
  "contacts.create_many",
  "contacts.delete",
  "templates.delete",
] as const;

describe("Sent registry connection", () => {
  it("uses the reviewed endpoint, user-scoped connector, and exact public tool allow-list", () => {
    expect(sent.url).toBe("https://mcp.sent.dm/mcp");
    expect(sent.tools).toEqual({ allow: PUBLIC_TOOLS });
    expect(sent.auth).toMatchObject({
      principalType: "user",
      vercelConnect: { connector: "sent" },
    });
  });

  it("requires approval for exactly the four reviewed mutations", async () => {
    const approval = sent.approval;
    if (typeof approval !== "function") {
      throw new TypeError("Sent must define a per-tool approval function");
    }

    for (const toolName of PUBLIC_TOOLS) {
      await expect(
        Promise.resolve(approval({ toolName: `sent__${toolName}` } as never)),
      ).resolves.toBe(
        MUTATING_TOOLS.includes(toolName as (typeof MUTATING_TOOLS)[number])
          ? "user-approval"
          : "not-applicable",
      );
    }
  });
});

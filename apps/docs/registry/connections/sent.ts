import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const APPROVAL_REQUIRED = new Set([
  "messages.send",
  "contacts.create_many",
  "contacts.delete",
  "templates.delete",
]);

export default defineMcpClientConnection({
  url: "https://mcp.sent.dm/mcp",
  description:
    "Sent business messaging: send and track SMS, WhatsApp, and RCS; manage contacts and templates; inspect analytics, balance, and account readiness.",
  auth: connect("sent"),
  tools: {
    allow: [
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
    ],
  },
  approval: ({ toolName }) =>
    [...APPROVAL_REQUIRED].some((name) => toolName.endsWith(`__${name}`))
      ? "user-approval"
      : "not-applicable",
});

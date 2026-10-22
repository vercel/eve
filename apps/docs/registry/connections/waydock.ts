import { defineMcpClientConnection } from "eve/connections";

const READ_ONLY_TOOLS = new Set([
  "waydock_accounts",
  "waydock_briefing",
  "waydock_calendar",
  "waydock_capabilities",
  "waydock_follow_ups_list",
  "waydock_health",
  "waydock_inbox",
  "waydock_mail_count",
  "waydock_mail_get",
  "waydock_mail_list",
  "waydock_mail_search",
  "waydock_meetings_list",
  "waydock_quota",
  "waydock_tasks_list",
  "waydock_version",
  "waydock_whoami",
]);

export default defineMcpClientConnection({
  url: "https://mcp.waydock.ai/mcp",
  description:
    "Waydock: access the user's mail, calendar, meetings, tasks, and follow-ups through its MCP server.",
  auth: {
    getToken: async () => {
      const token = process.env.WAYDOCK_MCP_KEY;
      if (!token) {
        throw new Error(
          "WAYDOCK_MCP_KEY is not set. Create a scoped key at https://waydock.ai/settings/account/mcp.",
        );
      }
      return { token };
    },
  },
  approval: ({ toolName }) =>
    READ_ONLY_TOOLS.has(toolName.split("__").pop() ?? toolName)
      ? "not-applicable"
      : "user-approval",
});

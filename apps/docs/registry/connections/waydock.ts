import { defineMcpClientConnection } from "eve/connections";

const READ_ONLY_TOOLS = new Set([
  "waydock_accounts",
  "waydock_action_items_list",
  "waydock_action_items_search",
  "waydock_agent_activity",
  "waydock_briefing",
  "waydock_calendar",
  "waydock_capabilities",
  "waydock_card_get",
  "waydock_follow_up_snoozes_list",
  "waydock_follow_ups_list",
  "waydock_health",
  "waydock_inbox",
  "waydock_key_info",
  "waydock_mail_accounts",
  "waydock_mail_attachments",
  "waydock_mail_count",
  "waydock_mail_get",
  "waydock_mail_list",
  "waydock_mail_search",
  "waydock_meeting_get",
  "waydock_meeting_transcript",
  "waydock_meetings_list",
  "waydock_morning_brief_compose",
  "waydock_morning_context",
  "waydock_outbound_audit",
  "waydock_preferences_get",
  "waydock_projects_list",
  "waydock_pulse_incidents",
  "waydock_pulse_keys_list",
  "waydock_pulse_status",
  "waydock_quota",
  "waydock_search",
  "waydock_suppressions_list",
  "waydock_sync_history",
  "waydock_tasks_list",
  "waydock_teams_get_messages",
  "waydock_teams_list_chats",
  "waydock_telemetry",
  "waydock_version",
  "waydock_whoami",
  "waydock_whoop_summary",
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

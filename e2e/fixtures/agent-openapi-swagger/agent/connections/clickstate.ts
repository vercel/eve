import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  defineMcpClientConnection,
} from "eve/connections";

const CONNECTION_NAME = "clickstate";
const CLICKSTATE_MCP_URL = "https://clickstate-mcp.vercel.sh/mcp";

const READ_ONLY_TOOLS = [
  "run_query",
  "list_warehouses",
  "search_schema",
  "describe",
  "describe_event_type",
  "get_query_guide",
  "resolve_project",
  "find_owner_by_host",
];

export default defineMcpClientConnection({
  url: CLICKSTATE_MCP_URL,
  description:
    "ClickState (read-only): query Vercel's ClickHouse warehouses for operational investigations, " +
    "including workflow runs, usage facts, telemetry, and runtime logs. Start with the matching " +
    "query guide, use schema discovery when fields are not established, and keep queries time-bounded and limited.",
  tools: { allow: READ_ONLY_TOOLS },
  // Mirror the user-scoped Connect lifecycle without making the e2e depend on
  // Vercel OIDC, connector installation, or the external MCP server.
  auth: defineInteractiveAuthorization({
    async getToken() {
      throw new ConnectionAuthorizationRequiredError(CONNECTION_NAME);
    },
    async startAuthorization({ principal }) {
      if (principal.type !== "user") {
        throw new Error(`${CONNECTION_NAME}: expected a user principal`);
      }
      return {
        challenge: {
          instructions: `CLICKSTATE_CURRENT_PRINCIPAL=user:${principal.id}`,
          url: "https://example.com/eve-e2e/authorize",
        },
      };
    },
    async completeAuthorization() {
      return { token: "unused" };
    },
  }),
});

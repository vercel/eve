import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

/**
 * Vercel Connect connector UID for the Notion MCP server.
 *
 * @defaultValue `"notion/marketing-team"`, the UID this template expects (UIDs are
 * `<type>/<name>`). Override it with the `NOTION_CONNECTOR` environment variable, set to the UID
 * that `vercel connect create notion --connection-method mcp --name <name>` prints.
 */
const notionConnector = process.env.NOTION_CONNECTOR ?? "notion/marketing-team";

/**
 * Bare Notion MCP tool names whose calls require human approval before running.
 *
 * @remarks
 * Add a tool's bare name here to gate it. eve hands the approval policy the qualified name,
 * `<connection>__<tool>`, where `<tool>` is exactly what the MCP server names it (e.g.
 * `notion__notion-update-page`; Notion's own tool names carry a `notion-` prefix). Entries are
 * matched as substrings, so they gate the tool regardless of the server's naming.
 *
 * `notion-update-page` is listed in the singular on purpose: as a substring it also matches a
 * plural `notion-update-pages`, so editing an existing page pauses whichever name the server
 * publishes. Page creation is deliberately absent, since drafting into Notion is the normal flow.
 */
const APPROVAL_REQUIRED_TOOLS = [
  "notion-move-pages",
  "notion-update-page",
  "notion-update-data-source",
  "notion-update-view",
];

/**
 * Build the Notion workspace connection (MCP): search, read, and edit tools for the model.
 *
 * @remarks
 * Connections are scoped to the agent that declares them and subagents inherit nothing, so the lead
 * and every specialist call this factory from a one-line `connections/notion.ts`. One definition
 * means the approval list is edited once and cannot drift between agents.
 *
 * Authorization is user-scoped via Vercel Connect: each user signs in through their own browser
 * consent flow, the per-user token is resolved before every tool call, and it is never exposed to
 * the model.
 *
 * Tools listed in {@link APPROVAL_REQUIRED_TOOLS} are gated on human approval: a gated call pauses
 * for an approve/deny decision (rendered as a Slack button) before it runs.
 *
 * @returns The Notion connection definition.
 * @see {@link https://vercel.com/docs/connect | Vercel Connect}
 */
export const notionConnection = () =>
  defineMcpClientConnection({
    approval: ({ toolName }) =>
      APPROVAL_REQUIRED_TOOLS.some((tool) => toolName.includes(tool))
        ? "user-approval"
        : "not-applicable",
    auth: connect(notionConnector),
    description:
      "Notion workspace: search, read, and edit pages and databases.",
    url: "https://mcp.notion.com/mcp",
  });

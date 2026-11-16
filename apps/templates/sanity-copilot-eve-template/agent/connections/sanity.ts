import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

/**
 * Vercel Connect connector UID for the Sanity MCP server.
 *
 * @defaultValue `"sanity/copilot-agent"`. Set the `SANITY_CONNECTOR` environment variable to the
 * UID that `vercel connect create` prints for your connector; it can differ from this default.
 */
const sanityConnector = process.env.SANITY_CONNECTOR ?? "sanity/copilot-agent";

/**
 * Bare Sanity MCP tool names whose calls require human approval before running.
 *
 * @remarks
 * Add a tool's bare name here to gate it. eve hands the approval policy the qualified name,
 * `<connection>__<tool>`, where `<tool>` is exactly what the MCP server names it (e.g.
 * `sanity__patch_documents`). Entries are matched as substrings, so they gate the tool
 * regardless of the server's naming.
 */
const APPROVAL_REQUIRED_TOOLS = [
  "patch_documents",
  "publish_documents",
  "unpublish_documents",
  "discard_drafts",
  "version_discard",
  "update_dataset",
  "deploy_schema",
  "deploy_studio",
];

/**
 * Sanity connection (MCP) exposing search, read, and edit tools to the model.
 *
 * @remarks
 * Authorization is user-scoped via Vercel Connect: each user signs in through their own
 * browser consent flow, the per-user token is resolved before every tool call, and it is
 * never exposed to the model.
 *
 * Tools listed in {@link APPROVAL_REQUIRED_TOOLS} are gated on human approval: a gated call
 * pauses for an approve/deny decision (rendered as a Slack button) before it runs.
 *
 * @see {@link https://vercel.com/docs/connect | Vercel Connect}
 */
export default defineMcpClientConnection({
  approval: ({ toolName }) =>
    APPROVAL_REQUIRED_TOOLS.some((tool) => toolName.includes(tool))
      ? "user-approval"
      : "not-applicable",
  auth: connect(sanityConnector),
  description:
    "Sanity CMS: query documents with GROQ, inspect schemas, create/edit drafts, manage " +
    "releases, generate media.",
  url: "https://mcp.sanity.io",
});

import { defineMcpClientConnection } from "eve/connections";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { linearAuth } from "../lib/constants.js";
import { isTrusted } from "../lib/trust.js";

/**
 * Linear MCP connection for creating and cross-referencing issues.
 *
 * @remarks
 * - Points at Linear's hosted MCP server and authenticates with the shared
 *   app-scoped `linearAuth` from `agent/lib/constants.ts`, so this connection
 *   and any tool calling the Linear API directly share one installation and
 *   one set of scopes. Tokens are resolved per call and never exposed to the
 *   model.
 * - All tools, including reads, require trusted Linear webhook auth from the
 *   explicitly configured workspace. GitHub identity or repository trust is
 *   not evidence of Linear workspace membership.
 */
export default defineMcpClientConnection({
  approval: (ctx: ApprovalContext): ApprovalStatus =>
    isTrusted(ctx.session.auth.current) &&
    ctx.session.auth.current?.authenticator === "linear-agent-webhook" &&
    process.env.LINEAR_WORKSPACE_ID &&
    ctx.session.auth.current.attributes.organization_id ===
      process.env.LINEAR_WORKSPACE_ID
      ? "not-applicable"
      : {
          reason:
            "Linear tools require a verified member session from the configured Linear workspace.",
          type: "denied",
        },
  auth: linearAuth,
  description: "Linear workspace: issues, projects, cycles, and comments.",
  url: "https://mcp.linear.app/mcp",
});

/**
 * Identities and credentials shared by the agent and its evals. Everything
 * here is fixture-only: the deployment is a protected preview, and these
 * values exist so the fixture can call itself without injected env.
 */

/** Header naming the person behind an eve-channel request. */
export const USER_HEADER = "x-eve-fixture-user";

/** The service principal the loopback connection authenticates as. */
export const SERVICE_ID = "maple-router";

/** Bearer token the loopback connection presents to the MCP channel. Fixture-only. */
export const SERVICE_TOKEN = "agent-mcp-fixture-service-token";

/** The connection the agent uses to reach its own MCP channel. */
export const LOOPBACK_CONNECTION = "loopback";

export const MCP_PATH = "/eve/v1/mcp";

/** This deployment's MCP channel, the way `kennelUrl()` reaches its own kennel. */
export function selfMcpUrl(): string {
  const deploymentHost = process.env.VERCEL_URL;
  const host = deploymentHost
    ? `https://${deploymentHost}`
    : (process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://127.0.0.1:3000");
  return `${host}${process.env.EVE_PUBLIC_ROUTE_PREFIX ?? ""}${MCP_PATH}`;
}

/** Lets self-calls reach a protected preview deployment of this fixture. */
export function previewBypassHeaders(): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return bypass ? { "x-vercel-protection-bypass": bypass } : {};
}

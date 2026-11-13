import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { SRE_VERCEL_CONNECTOR } from "#lib/constants.ts";

const VERCEL_MCP_TOOLS = [
  "list_teams",
  "list_projects",
  "get_project",
  "list_deployments",
  "get_deployment",
  "get_deployment_build_logs",
  "get_runtime_logs",
  "get_runtime_errors",
  "get_web_analytics",
  "list_agent_run_projects",
  "list_agent_runs",
  "get_agent_run",
  "get_agent_run_trace",
] as const;

export default defineMcpClientConnection({
  auth: connect(SRE_VERCEL_CONNECTOR),
  description:
    "Vercel production observability: projects, deployments, build logs, runtime logs and errors, web analytics, and eve Agent Runs. Read-only.",
  tools: {
    allow: [...VERCEL_MCP_TOOLS],
  },
  url: "https://mcp.vercel.com",
});

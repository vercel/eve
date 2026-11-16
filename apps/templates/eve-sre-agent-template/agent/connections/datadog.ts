import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { DATADOG_CONNECTOR, DATADOG_MCP_HOST } from "#lib/constants.ts";

const DATADOG_MCP_TOOLSETS = ["core", "software-delivery"] as const;

export const DATADOG_MCP_TOOLS = [
  "search_datadog_events",
  "get_datadog_metric",
  "get_datadog_metric_context",
  "search_datadog_monitors",
  "get_datadog_trace",
  "search_datadog_dashboards",
  "get_datadog_notebook",
  "search_datadog_notebooks",
  "search_datadog_hosts",
  "search_datadog_metrics",
  "search_datadog_services",
  "search_datadog_service_dependencies",
  "search_datadog_spans",
  "analyze_datadog_logs",
  "search_datadog_logs",
  "search_datadog_rum_events",
  "get_datadog_dashboard",
  "search_datadog_ci_pipeline_events",
  "aggregate_datadog_ci_pipeline_events",
] as const;

/**
 * Datadog exposes a lot of tools by default - this connection is allowlisted to a subset of all available tools
 * on the MCP server. See https://docs.datadoghq.com/mcp_server/tools for all of the available tools.
 */
export default defineMcpClientConnection({
  auth: connect({
    connector: DATADOG_CONNECTOR,
    displayName: "Datadog",
    principalType: "app",
  }),
  description:
    "Datadog observability: metrics, logs, traces, monitors, dashboards, notebooks, RUM, hosts, services, APM, CI pipelines, and more.",
  tools: {
    allow: [...DATADOG_MCP_TOOLS],
  },
  url: `https://${DATADOG_MCP_HOST}/v1/mcp?toolsets=${DATADOG_MCP_TOOLSETS.join(",")}`,
});

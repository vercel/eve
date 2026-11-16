export const SLACK_CONNECTOR = process.env.SLACK_CONNECTOR ?? "slack/sre";
export const GITHUB_CONNECTOR = process.env.GITHUB_CONNECTOR ?? "github/sre";
export const DATADOG_CONNECTOR = process.env.DATADOG_CONNECTOR ?? "datadog/sre";
export const DATADOG_SITE = process.env.DD_SITE ?? "datadoghq.com";
export const DATADOG_MCP_HOST = `mcp.${DATADOG_SITE}`;
export const SRE_VERCEL_CONNECTOR =
  process.env.SRE_VERCEL_CONNECTOR ?? "vercel/sre";

import type { ConnectorDef } from "#shared/types/connector";
import { GITHUB_CONNECTOR } from "#shared/connect";
import { fetchLinearIssuesViaGraphql, fetchLinearIssuesViaMcp } from "~~/server/utils/linear-mcp";

export const connectors: ConnectorDef[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests, and CI workflows.",
    connector: GITHUB_CONNECTOR,
    connectionName: "github",
    icon: "i-simple-icons-github",
    scopes: ["repo"],
    test: {
      label: "List my repositories",
      run: async (token) => {
        const res = await fetch("https://api.github.com/user/repos?per_page=5", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "personal-agent-template",
          },
        });

        if (!res.ok) {
          throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
        }

        const repos = (await res.json()) as Array<{ full_name: string }>;
        return repos.map((repo) => repo.full_name);
      },
    },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects, cycles, and comments in your Linear workspace.",
    connector: "mcp.linear.app/linear",
    connectionName: "linear",
    icon: "i-simple-icons-linear",
    scopes: [],
    test: {
      label: "List my issues",
      run: async (token) => {
        const mcpResult = await fetchLinearIssuesViaMcp(token);
        if (mcpResult.ok) {
          return mcpResult.results;
        }

        const graphqlResult = await fetchLinearIssuesViaGraphql(token);
        if (graphqlResult.ok) {
          return graphqlResult.results;
        }

        throw new Error(mcpResult.error ?? graphqlResult.error ?? "Linear test failed");
      },
    },
  },
];

export function getConnector(id: string): ConnectorDef {
  const connector = connectors.find((entry) => entry.id === id);

  if (!connector) {
    throw createError({
      statusCode: 404,
      statusMessage: "Connector not found",
    });
  }

  return connector;
}

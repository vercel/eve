import type { ResolvedConnectionDefinition } from "#runtime/types.js";

/**
 * Formats the "Connections" system prompt section listing all available
 * connections and their descriptions.
 *
 * Called at graph resolution time so the section is part of the turn
 * agent's static instructions rather than injected per-step.
 */
export function formatConnectionsSection(
  connections: readonly ResolvedConnectionDefinition[],
): string {
  const connectionList = connections.map((c) => `- ${c.connectionName}: ${c.description}`);

  return [
    "## Connections",
    "",
    "You have direct access to the following external services through connected MCP servers and OpenAPI HTTP APIs.",
    "When the user's request relates to any of these services, use them instead of web search or general knowledge.",
    "",
    "Available connections:",
    ...connectionList,
    "",
    "Use connection__search to discover specific tools within a connection. Discovered tools become directly callable by their qualified name (e.g. connection__linear__list_issues) in your next response.",
  ].join("\n");
}

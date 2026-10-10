export const agentRuntimeDiagram = {
  runtime: {
    title: "Trusted app runtime",
    description: "Full Node.js access and credentials",
    cards: [
      {
        id: "agent-loop",
        title: "Agent loop",
        description: "Durable workflow, model calls, and orchestration",
        paths: ["agent/agent.ts", "agent/instructions.md"],
      },
      {
        id: "runtime-code",
        title: "Runtime code",
        description: "Tools, hooks, instrumentation, and connections",
        paths: [
          "agent/tools/**",
          "agent/hooks/**",
          "agent/instrumentation/**",
          "agent/connections/**",
        ],
      },
      {
        id: "credentials",
        title: "Secrets and credentials",
        description: "Provider keys, tool secrets, and MCP/OpenAPI auth stay here",
      },
    ],
  },
  bridge: "ctx.getSandbox()",
  sandbox: {
    title: "Isolated sandbox",
    description: "Filesystem and processes without app secrets",
    cards: [
      {
        id: "skills",
        title: "Skills",
        description: "Materialized for the agent",
        paths: ["$HOME/.agents/skills", "from agent/skills/**"],
      },
      {
        id: "sandbox-operations",
        title: "Sandbox operations",
        description: "Shell commands, file access, scripts, and servers",
      },
      {
        id: "workspace",
        title: "Workspace",
        description: "Persistent per-session files",
        paths: ["/workspace", "from agent/sandbox/workspace/**"],
      },
    ],
  },
} as const;

export type CardId = (typeof agentRuntimeDiagram)["runtime" | "sandbox"]["cards"][number]["id"];

function renderEnvironment(environment: {
  title: string;
  description: string;
  cards: readonly { title: string; description: string; paths?: readonly string[] }[];
}): string {
  return [
    `**${environment.title}** — ${environment.description}`,
    ...environment.cards.map(
      (card) =>
        `- **${card.title}** — ${card.description}${
          card.paths ? `\n${card.paths.map((path) => `  - \`${path}\``).join("\n")}` : ""
        }`,
    ),
  ].join("\n\n");
}

export function renderAgentRuntimeDiagramMarkdown(): string {
  return [
    renderEnvironment(agentRuntimeDiagram.runtime),
    `App runtime → \`${agentRuntimeDiagram.bridge}\` → sandbox`,
    renderEnvironment(agentRuntimeDiagram.sandbox),
  ].join("\n\n");
}

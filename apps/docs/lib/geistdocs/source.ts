import { createSource, type FumadocsCollection } from "@vercel/geistdocs/source";
import { docs } from "@/.source/server";
import { config } from "./config";

const markdownComponentFallbacks: Record<string, string> = {
  '<EveCodeBenchmark dataset="deepswe-lean" />':
    "Benchmark results are interactive and are not included in Markdown. Lines are 95% intervals; overlapping lines are not a measured difference. Click a contender to open its run.",
  "<AgentRuntimeDiagram />": `| Environment | Component | Responsibility | Agent paths |
| --- | --- | --- | --- |
| Trusted app runtime | Agent loop | Durable workflow, model calls, and orchestration | \`agent/agent.ts\`, \`agent/instructions.md\` |
| Trusted app runtime | Runtime code | Tools, hooks, instrumentation, and connections | \`agent/tools/**\`, \`agent/hooks/**\`, \`agent/instrumentation/**\`, \`agent/connections/**\` |
| Trusted app runtime | Secrets and credentials | Provider keys, tool secrets, and MCP/OpenAPI auth stay here | |
| Isolated sandbox | Skills | Materialized for the agent | \`$HOME/.agents/skills\`; from \`agent/skills/**\` |
| Isolated sandbox | Sandbox operations | Shell commands, file access, scripts, and servers | |
| Isolated sandbox | Workspace | Persistent per-session files | \`/workspace\`; from \`agent/sandbox/workspace/**\` |

The app runtime reaches the sandbox through \`ctx.getSandbox()\`.`,
};

const transformMarkdownComponents = (markdown: string): string =>
  Object.entries(markdownComponentFallbacks).reduce(
    (content, [component, fallback]) => content.replaceAll(component, fallback),
    markdown,
  );

// If a page has a `url:` frontmatter field, use it as the routing slug so
// a file like channels/README.md can render at /docs/channels without being
// renamed on disk.
const docsSource = docs.toFumadocsSource();

const baseSource = {
  files: [...docsSource.files],
};

for (const file of baseSource.files) {
  if (file.type !== "page") continue;
  const override = (file.data as { url?: unknown } | undefined)?.url;
  if (typeof override !== "string" || !override.startsWith("/")) continue;
  (file as { slugs?: string[] }).slugs = override.slice(1).split("/").filter(Boolean);
}

const mergedDocs: FumadocsCollection = {
  toFumadocsSource: () => baseSource,
};

export const geistdocsSource = createSource({
  docs: mergedDocs,
  config,
  id: "docs",
  label: "Docs",
  markdown: { transform: transformMarkdownComponents },
});

export const source = geistdocsSource.source;
export const getPageImage = geistdocsSource.getPageImage;
export const getLLMText = geistdocsSource.getPageMarkdown;

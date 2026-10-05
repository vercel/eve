import { createProcessor } from "@mdx-js/mdx";
import { toMarkdown, type Options } from "mdast-util-to-markdown";
import { describe, expect, it } from "vitest";
import { remarkComponentMarkdown } from "./remark-component-markdown";
import config from "../../source.config";

describe("component Markdown export", () => {
  it("expands the runtime diagram without changing HTML or component examples", async () => {
    const options =
      typeof config.mdxOptions === "function" ? await config.mdxOptions() : config.mdxOptions;
    const plugins = options?.remarkPlugins;
    if (!Array.isArray(plugins)) throw new Error("Expected configured remark plugins");
    const processor = createProcessor({ remarkPlugins: plugins });
    const source = [
      "## Agent loop and sandbox",
      "",
      "<AgentRuntimeDiagram />",
      "",
      "<Callout>Keep this content.</Callout>",
      "",
      '<EveCodeBenchmark dataset="deepswe-lean" />',
      "",
      "```mdx",
      "<AgentRuntimeDiagram />",
      "```",
    ].join("\n");
    const tree = processor.parse(source);
    const markdown = toMarkdown(tree, {
      extensions: (processor.data() as { toMarkdownExtensions?: Options[] }).toMarkdownExtensions,
    });

    expect(markdown).toContain("**Trusted app runtime** — Full Node.js access and credentials");
    expect(markdown).toContain("**Agent loop** — Durable workflow, model calls, and orchestration");
    expect(markdown).toContain("`agent/agent.ts`");
    expect(markdown).toContain("`agent/instructions.md`");
    expect(markdown).toContain("**Runtime code** — Tools, hooks, instrumentation, and connections");
    expect(markdown).toContain("`agent/tools/**`");
    expect(markdown).toContain("`agent/hooks/**`");
    expect(markdown).toContain("`agent/instrumentation/**`");
    expect(markdown).toContain("`agent/connections/**`");
    expect(markdown).toContain(
      "**Secrets and credentials** — Provider keys, tool secrets, and MCP/OpenAPI auth stay here",
    );
    expect(markdown).toContain("`ctx.getSandbox()`");
    expect(markdown).toContain(
      "**Isolated sandbox** — Filesystem and processes without app secrets",
    );
    expect(markdown).toContain("**Skills** — Materialized for the agent");
    expect(markdown).toContain("`$HOME/.agents/skills`");
    expect(markdown).toContain("`from agent/skills/**`");
    expect(markdown).toContain(
      "**Sandbox operations** — Shell commands, file access, scripts, and servers",
    );
    expect(markdown).toContain("**Workspace** — Persistent per-session files");
    expect(markdown).toContain("`/workspace`");
    expect(markdown).toContain("`from agent/sandbox/workspace/**`");
    expect(markdown).toContain(
      "| Harness | Resolved | 95% interval | Median latency | p90 latency | Measured |",
    );
    expect(markdown).toContain("<Callout>");
    expect(markdown).toContain("Keep this content.");
    expect(markdown).toContain("</Callout>");
    expect(markdown).toContain("```mdx\n<AgentRuntimeDiagram />\n```");
    expect(markdown.match(/<AgentRuntimeDiagram \/>/g)).toHaveLength(1);

    expect(tree.children).toContainEqual(
      expect.objectContaining({ type: "mdxJsxFlowElement", name: "AgentRuntimeDiagram" }),
    );
  });
});

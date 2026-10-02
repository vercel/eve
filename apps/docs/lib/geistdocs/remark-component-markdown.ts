import { mdxJsxToMarkdown } from "mdast-util-mdx-jsx";
import type { Options } from "mdast-util-to-markdown";
import { renderAgentRuntimeDiagramMarkdown } from "./agent-runtime-diagram";

// Customize serialization only: the MDX tree must keep the visual component for HTML.
export function remarkComponentMarkdown(this: { data(): unknown }): void {
  const data = this.data() as { toMarkdownExtensions?: Options[] };
  const extensions = (data.toMarkdownExtensions ??= []);
  const fallback = mdxJsxToMarkdown().handlers!.mdxJsxFlowElement!;
  extensions.push({
    handlers: {
      mdxJsxFlowElement(node, parent, state, info) {
        if (node.name === "AgentRuntimeDiagram") return renderAgentRuntimeDiagramMarkdown();
        return fallback(node, parent, state, info);
      },
    },
  });
}

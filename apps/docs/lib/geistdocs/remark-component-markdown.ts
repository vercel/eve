import { mdxJsxToMarkdown, type MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import type { Options } from "mdast-util-to-markdown";
import { renderBenchmarkMarkdown } from "../evals/eve-code-format";
import { eveCodeBenchmark } from "../evals/eve-code-results";
import { renderAgentRuntimeDiagramMarkdown } from "./agent-runtime-diagram";

// Customize serialization only: the MDX tree must keep the visual component for HTML.
export function remarkComponentMarkdown(this: { data(): unknown }): void {
  const data = this.data() as { toMarkdownExtensions?: Options[] };
  const extensions = (data.toMarkdownExtensions ??= []);
  const fallback = mdxJsxToMarkdown().handlers!.mdxJsxFlowElement!;
  extensions.push({
    handlers: {
      mdxJsxFlowElement(node: MdxJsxFlowElement, parent, state, info) {
        if (node.name === "AgentRuntimeDiagram") return renderAgentRuntimeDiagramMarkdown();
        if (node.name === "EveCodeBenchmark") {
          const dataset = node.attributes.find(
            (attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === "dataset",
          );
          if (dataset?.type !== "mdxJsxAttribute" || typeof dataset.value !== "string") {
            throw new Error("EveCodeBenchmark Markdown export requires a literal dataset string.");
          }
          return renderBenchmarkMarkdown(eveCodeBenchmark.datasets[dataset.value], dataset.value);
        }
        return fallback(node, parent, state, info);
      },
    },
  });
}

import { mdxJsxToMarkdown, type MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import type { Options } from "mdast-util-to-markdown";
import { renderBenchmarkMarkdown } from "../evals/eve-code-format";
import { eveCodeBenchmark } from "../evals/eve-code-results";
import { templateManifest } from "../templates/manifest";
import { renderAgentRuntimeDiagramMarkdown } from "./agent-runtime-diagram";
import { templatePath } from "./canonical";

type CardProps = Partial<Record<string, string>>;

// Card components keep their copy in MDX props and children; render each as one list item.
const cardMarkdown = new Map<string, (props: CardProps, text: string) => string>([
  [
    "UseCaseSummary",
    (props, text) => `- **[${props.title}](${props.href})** (${props.audience}): ${text}`,
  ],
  [
    "TemplateCard",
    (props, text) => {
      const template = templateManifest.find((entry) => entry.slug === props.template);
      if (!template) throw new Error(`Unknown template "${props.template}" in a TemplateCard.`);
      const label = `${props.label ?? template.title} template`;
      return `- **${props.title}**: ${text} See the [${label}](${templatePath(template.slug)}).`;
    },
  ],
  [
    "Capability",
    (props, text) => `- **${props.title}**: ${text} See [${props.link}](${props.href}).`,
  ],
]);
const cardLists = new Set(["UseCaseSummaries", "TemplateCards", "Capabilities"]);

const stringProps = (node: MdxJsxFlowElement): CardProps =>
  Object.fromEntries(
    node.attributes.flatMap((attribute) =>
      attribute.type === "mdxJsxAttribute" && typeof attribute.value === "string"
        ? [[attribute.name, attribute.value]]
        : [],
    ),
  );

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
        if (node.name && cardLists.has(node.name)) {
          return node.children.map((child) => state.handle(child, node, state, info)).join("\n");
        }
        const card = node.name ? cardMarkdown.get(node.name) : undefined;
        if (card) {
          const text = state.containerFlow(node, info).replace(/\s+/g, " ").trim();
          return card(stringProps(node), text);
        }
        return fallback(node, parent, state, info);
      },
    },
  });
}

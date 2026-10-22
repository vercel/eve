import { mdxJsxToMarkdown, type MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import type { Options } from "mdast-util-to-markdown";
import { renderBenchmarkMarkdown } from "../evals/eve-code-format";
import { eveCodeBenchmark } from "../evals/eve-code-results";
import { renderAgentRuntimeDiagramMarkdown } from "./agent-runtime-diagram";
import {
  isUseCaseId,
  renderUseCaseCapabilitiesMarkdown,
  renderUseCaseOverviewMarkdown,
  renderUseCasePatternsMarkdown,
  type UseCaseId,
} from "./use-cases";

const useCaseRenderers = new Map<string, (useCase: UseCaseId) => string>([
  ["UseCaseCapabilities", renderUseCaseCapabilitiesMarkdown],
  ["UseCasePatterns", renderUseCasePatternsMarkdown],
]);

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
        if (node.name === "UseCaseOverview") return renderUseCaseOverviewMarkdown();
        const renderUseCase = useCaseRenderers.get(node.name ?? "");
        if (renderUseCase) {
          const useCase = node.attributes.find(
            (attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === "useCase",
          );
          if (useCase?.type !== "mdxJsxAttribute" || !isUseCaseId(useCase.value)) {
            throw new Error(`${node.name} Markdown export requires a literal useCase string.`);
          }
          return renderUseCase(useCase.value);
        }
        return fallback(node, parent, state, info);
      },
    },
  });
}

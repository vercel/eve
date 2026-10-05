import { createSource, type FumadocsCollection } from "@vercel/geistdocs/source";
import { docs } from "@/.source/server";
import { config } from "./config";

const markdownComponentFallbacks: Record<string, string> = {
  '<EveCodeBenchmark dataset="deepswe-lean" />':
    "Benchmark results are interactive and are not included in Markdown. Lines are 95% intervals; overlapping lines are not a measured difference. Click a contender to open its run.",
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

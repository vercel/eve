import { createSource, type FumadocsCollection } from "@vercel/geistdocs/source";
import { docs } from "@/.source/server";
import { config } from "./config";

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
});

export const source = geistdocsSource.source;
export const getPageImage = geistdocsSource.getPageImage;
export const getLLMText = geistdocsSource.getPageMarkdown;

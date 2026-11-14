import { isBrowserImageArtifactUrl } from "@shared/browser/artifact";

const imageArtifactMarkdownPattern =
  /!\[((?:\\.|[^\]])*)\]\((\/artifacts\/([^\s)]+))\)/giu;

export function extractImageArtifactMarkdownReferences(message: string) {
  const references: {
    readonly id: string;
    readonly label: string;
    readonly markdown: string;
    readonly url: string;
  }[] = [];
  const seen = new Set<string>();

  for (const match of message.matchAll(imageArtifactMarkdownPattern)) {
    const [markdown, label, url, id] = match;
    if (!markdown || !url || !id || seen.has(id)) continue;
    if (!isBrowserImageArtifactUrl(url)) continue;
    seen.add(id);
    references.push({ id, label: label ?? "", markdown, url });
  }

  return references;
}

export function stripImageArtifactMarkdownReferences(message: string) {
  return message
    .replace(imageArtifactMarkdownPattern, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

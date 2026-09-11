import type { getToolName } from "ai";
import { getDomain, getFaviconUrl } from "~/utils/url";

export interface Source {
  url: string;
  title?: string;
}

interface GoogleGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface SearchOutput {
  sources?: { url: string; type?: string }[];
  groundingChunks?: GoogleGroundingChunk[];
  groundingMetadata?: { groundingChunks?: GoogleGroundingChunk[] };
}

type ToolPart = Parameters<typeof getToolName>[0];

export function getSearchQuery(part: ToolPart): string | undefined {
  return (part.input as { query?: string } | undefined)?.query;
}

export function getSources(part: ToolPart): Source[] {
  const output = part.output;
  if (!output) return [];

  if (Array.isArray(output)) {
    return output.filter((s: Source) => s.url).map((s: Source) => ({ url: s.url, title: s.title }));
  }

  const typed = output as SearchOutput;

  if (typed.sources) {
    return typed.sources.filter((s) => s.url).map((s) => ({ url: s.url }));
  }

  const chunks = typed.groundingChunks ?? typed.groundingMetadata?.groundingChunks;
  if (chunks) {
    return chunks.filter((c) => c.web?.uri).map((c) => ({ url: c.web!.uri!, title: c.web!.title }));
  }

  return [];
}

export function sourceToInlineMdc(url: string): string {
  const domain = getDomain(url);
  const favicon = getFaviconUrl(url);
  const safeUrl = url.replace(/"/g, "&quot;");
  const safeFavicon = favicon.replace(/"/g, "&quot;");

  return ` :source-link{url="${safeUrl}" favicon="${safeFavicon}" label="${domain}"}`;
}

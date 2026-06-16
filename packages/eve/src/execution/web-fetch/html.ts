import TurndownService from "#compiled/turndown/index.js";

/**
 * Converts an HTML string to Markdown using Turndown.
 *
 * Removes `<script>`, `<style>`, `<meta>`, and `<link>` elements before
 * conversion to keep the output focused on document content.
 */
export function convertHtmlToMarkdown(html: string): string {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
    hr: "---",
  });

  service.remove(["script", "style", "meta", "link"]);

  return service.turndown(html);
}

/**
 * Strips HTML tags and extracts readable text content.
 *
 * Removes content inside `<script>`, `<style>`, and `<noscript>` elements,
 * replaces block-level tags with newlines, decodes common HTML entities, and
 * normalises whitespace.
 */
export function extractTextFromHtml(html: string): string {
  let text = html;

  // Remove content inside script, style, and noscript elements.
  text = text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Replace block-level closing tags with newlines for readable output.
  text = text.replace(
    /<\/(p|div|br|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|aside|main|figure|figcaption|details|summary)>/gi,
    "\n",
  );

  // Replace self-closing <br> variants with newlines.
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip all remaining HTML tags.
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities.
  text = decodeHtmlEntities(text);

  // Collapse runs of whitespace on each line, then collapse blank lines.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&nbsp;": " ",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&#x2F;": "/",
};

const ENTITY_PATTERN = new RegExp(Object.keys(ENTITY_MAP).join("|"), "gi");

function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (match) => ENTITY_MAP[match.toLowerCase()] ?? match);
}

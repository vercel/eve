import TurndownService from "#compiled/turndown/index.js";

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

export function extractTextFromHtml(html: string): string {
  let text = stripTags(html);

  text = decodeHtmlEntities(text);

  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

const RAW_TEXT_CLOSE_TAGS = new Map([
  ["noscript", /<\/noscript(?=[\s/>])/gi],
  ["script", /<\/script(?=[\s/>])/gi],
  ["style", /<\/style(?=[\s/>])/gi],
]);

const BLOCK_ELEMENTS = new Set([
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "summary",
  "tr",
]);

const TAG_NAME_PATTERN = /^(\/?)([^\s/>]+)/;

function stripTags(html: string): string {
  const parts: string[] = [];
  let pos = 0;

  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open === -1) break;

    if (html.startsWith("<!--", open)) {
      parts.push(html.slice(pos, open));
      const end = html.indexOf("-->", open + 4);
      pos = end === -1 ? html.length : end + 3;
      continue;
    }

    const close = html.indexOf(">", open + 1);
    if (close === -1) break;

    parts.push(html.slice(pos, open));
    pos = close + 1;

    const name = TAG_NAME_PATTERN.exec(html.slice(open + 1, close));
    if (!name) continue;
    const isClosing = name[1] === "/";
    const tagName = name[2]!.toLowerCase();

    if (tagName === "br" || (isClosing && BLOCK_ELEMENTS.has(tagName))) {
      parts.push("\n");
      continue;
    }

    const rawTextClose = isClosing ? undefined : RAW_TEXT_CLOSE_TAGS.get(tagName);
    if (rawTextClose) {
      rawTextClose.lastIndex = pos;
      const end = rawTextClose.exec(html) ? html.indexOf(">", rawTextClose.lastIndex) : -1;
      pos = end === -1 ? html.length : end + 1;
    }
  }

  parts.push(html.slice(pos));
  return parts.join("");
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

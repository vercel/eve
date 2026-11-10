/**
 * Minimal HTML-to-Markdown conversion for model-facing text.
 *
 * eve converts two kinds of HTML: pages fetched by the web fetch tool and
 * Microsoft Teams message bodies. Both only need readable Markdown for a
 * model, so this covers the common document subset (headings, paragraphs,
 * emphasis, links, images, lists, code, quotes, rules, and simple tables) and
 * renders everything else as its text.
 *
 * Fetched HTML is untrusted and can be megabytes long, so parsing is a single
 * forward pass, every scan resumes past the previous match, and element
 * nesting is capped. Work stays linear in the input size and rendering
 * recursion stays bounded no matter how the markup is shaped.
 */

interface ElementNode {
  readonly name: string;
  /** Raw attribute source, parsed only for the few elements that need it. */
  readonly attrs: string;
  readonly children: Node[];
}

type Node = ElementNode | string;

/** Deeper elements are flattened into their ancestor at the cap. */
const MAX_DEPTH = 128;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements dropped with their content, which is skipped as raw text. */
const SKIPPED_ELEMENTS = new Set([
  "canvas",
  "iframe",
  "math",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
]);

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "ul",
]);

const LIST_ELEMENTS = new Set(["dir", "menu", "ol", "ul"]);

/**
 * Converts an HTML string to Markdown with ATX headings, `-` bullets, fenced
 * code blocks, `*` emphasis, and `---` rules.
 */
export function convertHtmlToMarkdown(html: string): string {
  return renderBlocks(parseHtml(html).children).join("\n\n");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseHtml(html: string): ElementNode {
  const root: ElementNode = { name: "#root", attrs: "", children: [] };
  const stack: ElementNode[] = [root];
  let pos = 0;

  const current = () => stack[stack.length - 1]!;
  const pushText = (end: number) => {
    if (end > pos) current().children.push(html.slice(pos, end));
  };

  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open === -1) break;

    const next = html.charCodeAt(open + 1);
    const isTagStart = isAsciiLetter(next) || next === 47; /* / */
    const isMarkup = next === 33 /* ! */ || next === 63; /* ? */
    if (!isTagStart && !isMarkup) {
      // A literal `<`, such as `a < b`. Keep it as text.
      pushText(open + 1);
      pos = open + 1;
      continue;
    }

    pushText(open);

    if (isMarkup) {
      // Comments, doctypes, CDATA, and processing instructions.
      const terminator = html.startsWith("<!--", open) ? "-->" : ">";
      const end = html.indexOf(terminator, open + 2);
      pos = end === -1 ? html.length : end + terminator.length;
      continue;
    }

    const close = findTagEnd(html, open + 1);
    if (close === -1) {
      // No complete tag remains, so the rest is text.
      pos = open;
      break;
    }
    pos = close + 1;

    const source = html.slice(open + 1, close);
    const isClosing = source.charCodeAt(0) === 47;
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(isClosing ? source.slice(1) : source);
    if (!nameMatch) continue;
    const name = nameMatch[0].toLowerCase();

    if (isClosing) {
      if (name === "br") {
        current().children.push({ name, attrs: "", children: [] });
      } else {
        closeElement(stack, name);
      }
      continue;
    }

    if (SKIPPED_ELEMENTS.has(name)) {
      pos = skipRawText(html, name, pos);
      continue;
    }

    closeImplicitly(stack, name);
    const element: ElementNode = {
      name,
      attrs: source.slice(nameMatch[0].length),
      children: [],
    };
    current().children.push(element);

    const selfClosing = source.charCodeAt(source.length - 1) === 47;
    if (!VOID_ELEMENTS.has(name) && !selfClosing && stack.length < MAX_DEPTH) {
      stack.push(element);
    }
  }

  if (pos < html.length) current().children.push(html.slice(pos));
  return root;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Finds the `>` that ends a tag, ignoring `>` inside quoted attribute values. */
function findTagEnd(html: string, from: number): number {
  let quote = 0;
  let previous = 0;
  for (let i = from; i < html.length; i++) {
    const code = html.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if ((code === 34 || code === 39) && previous === 61 /* = */) {
      quote = code;
    } else if (code === 62) {
      return i;
    }
    if (code > 32) previous = code;
  }
  return -1;
}

/** Returns the index just past `</name ...>`, or the end of input. */
function skipRawText(html: string, name: string, from: number): number {
  const pattern = new RegExp(`</${name}(?=[\\s/>])`, "gi");
  pattern.lastIndex = from;
  if (!pattern.exec(html)) return html.length;
  const end = html.indexOf(">", pattern.lastIndex);
  return end === -1 ? html.length : end + 1;
}

function closeElement(stack: ElementNode[], name: string): void {
  // Stack depth is capped, so this search is bounded.
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i]!.name === name) {
      stack.length = i;
      return;
    }
  }
  // A stray closing tag with no open element is ignored.
}

/** Applies the common HTML auto-closing rules for lists, tables, and paragraphs. */
function closeImplicitly(stack: ElementNode[], name: string): void {
  if (name === "li") {
    closeWithin(stack, ["li"], LIST_ELEMENTS);
  } else if (name === "dt" || name === "dd") {
    closeWithin(stack, ["dt", "dd"], new Set(["dl"]));
  } else if (name === "tr") {
    closeWithin(stack, ["tr"], new Set(["table", "thead", "tbody", "tfoot"]));
  } else if (name === "td" || name === "th") {
    closeWithin(stack, ["td", "th"], new Set(["tr", "table"]));
  } else if (BLOCK_ELEMENTS.has(name) && stack[stack.length - 1]!.name === "p") {
    stack.pop();
  }
}

function closeWithin(
  stack: ElementNode[],
  names: readonly string[],
  boundaries: ReadonlySet<string>,
): void {
  for (let i = stack.length - 1; i > 0; i--) {
    const name = stack[i]!.name;
    if (boundaries.has(name)) return;
    if (names.includes(name)) {
      stack.length = i;
      return;
    }
  }
}

function readAttribute(attrs: string, wanted: string): string | undefined {
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of attrs.matchAll(pattern)) {
    if (match[1]!.toLowerCase() === wanted) {
      return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Renders nodes as Markdown blocks, grouping runs of inline content into paragraphs. */
function renderBlocks(nodes: readonly Node[]): string[] {
  const blocks: string[] = [];
  let inline: Node[] = [];

  const flush = () => {
    const text = normalizeInline(renderInline(inline));
    if (text) blocks.push(text);
    inline = [];
  };

  for (const node of nodes) {
    if (typeof node === "string" || !BLOCK_ELEMENTS.has(node.name)) {
      inline.push(node);
      continue;
    }
    flush();
    blocks.push(...renderBlockElement(node));
  }
  flush();
  return blocks;
}

function renderBlockElement(node: ElementNode): string[] {
  switch (node.name) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = normalizeInline(renderInline(node.children)).replace(/\n+/g, " ");
      return text ? [`${"#".repeat(Number(node.name[1]))} ${text}`] : [];
    }
    case "hr":
      return ["---"];
    case "pre":
      return [renderCodeBlock(node)];
    case "blockquote": {
      const content = renderBlocks(node.children).join("\n\n");
      return content ? [prefixLines(content, "> ", ">")] : [];
    }
    case "ol":
    case "ul":
    case "dir":
    case "menu": {
      const list = renderList(node);
      return list ? [list] : [];
    }
    case "table": {
      const table = renderTable(node);
      return table ? [table] : [];
    }
    default:
      return renderBlocks(node.children);
  }
}

function renderList(node: ElementNode): string {
  const ordered = node.name === "ol";
  const start = ordered ? Number.parseInt(readAttribute(node.attrs, "start") ?? "1", 10) : 1;
  let index = Number.isFinite(start) ? start : 1;
  const items: string[] = [];

  for (const child of node.children) {
    // Text between items is usually whitespace; anything else becomes its own item.
    const content =
      typeof child !== "string" && child.name === "li"
        ? renderBlocks(child.children).join("\n")
        : renderBlocks([child]).join("\n");
    if (!content) continue;

    const marker = ordered ? `${index++}. ` : "- ";
    const indent = " ".repeat(marker.length);
    items.push(marker + prefixLines(content, indent, "", true));
  }
  return items.join("\n");
}

function renderCodeBlock(node: ElementNode): string {
  const code = node.children.find(
    (child): child is ElementNode => typeof child !== "string" && child.name === "code",
  );
  const className = readAttribute(code?.attrs ?? "", "class") ?? readAttribute(node.attrs, "class");
  const language = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(className ?? "")?.[1] ?? "";

  const text = decodeEntities(textContent(node.children))
    .replace(/^\r?\n/, "")
    .trimEnd();
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function renderTable(node: ElementNode): string {
  const rows: string[][] = [];
  const blocks: string[] = [];

  const visit = (children: readonly Node[]) => {
    for (const child of children) {
      if (typeof child === "string") continue;
      if (child.name === "tr") {
        rows.push(
          child.children
            .filter(
              (cell): cell is ElementNode =>
                typeof cell !== "string" && (cell.name === "td" || cell.name === "th"),
            )
            .map((cell) =>
              normalizeInline(renderInline(cell.children))
                .replace(/\n+/g, " ")
                .replace(/\|/g, "\\|"),
            ),
        );
      } else if (child.name === "caption") {
        blocks.push(...renderBlocks(child.children));
      } else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") {
        visit(child.children);
      }
    }
  };
  visit(node.children);

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width > 0) {
    const line = (cells: readonly string[]) =>
      `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    const [header, ...body] = rows;
    blocks.push(
      [line(header!), line(Array.from({ length: width }, () => "---")), ...body.map(line)].join(
        "\n",
      ),
    );
  }
  return blocks.join("\n\n");
}

/** Renders inline Markdown. Block elements met here contribute their text. */
function renderInline(nodes: readonly Node[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    parts.push(typeof node === "string" ? renderText(node) : renderInlineElement(node));
  }
  return parts.join("");
}

function renderInlineElement(node: ElementNode): string {
  switch (node.name) {
    case "br":
      return "\n";
    case "strong":
    case "b":
      return wrap(renderInline(node.children), "**");
    case "em":
    case "i":
      return wrap(renderInline(node.children), "*");
    case "del":
    case "s":
    case "strike":
      return wrap(renderInline(node.children), "~~");
    case "code":
    case "kbd":
    case "samp":
      return renderInlineCode(node);
    case "a": {
      const text = renderInline(node.children);
      const href = readAttribute(node.attrs, "href");
      if (!href || !text.trim()) return text;
      const title = readAttribute(node.attrs, "title");
      const suffix = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
      return wrap(text, "[", `](${escapeUrl(href)}${suffix})`);
    }
    case "img": {
      const src = readAttribute(node.attrs, "src");
      if (!src) return "";
      const alt = (readAttribute(node.attrs, "alt") ?? "").replace(/\s+/g, " ");
      return `![${alt}](${escapeUrl(src)})`;
    }
    case "input":
      return "";
    default: {
      const text = renderInline(node.children);
      return BLOCK_ELEMENTS.has(node.name) ? ` ${text} ` : text;
    }
  }
}

function renderInlineCode(node: ElementNode): string {
  const text = decodeEntities(textContent(node.children)).replace(/\s+/g, " ");
  if (!text.trim()) return text;
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Wraps content in Markdown markers, keeping surrounding whitespace outside them. */
function wrap(content: string, before: string, after = before): string {
  const inner = content.trim();
  if (!inner) return content;
  const start = content.length - content.trimStart().length;
  const end = content.trimEnd().length;
  return `${content.slice(0, start)}${before}${inner}${after}${content.slice(end)}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function renderText(text: string): string {
  return decodeEntities(text.replace(/[ \t\n\r\f]+/g, " "));
}

function textContent(nodes: readonly Node[]): string {
  const parts: string[] = [];
  const visit = (children: readonly Node[]) => {
    for (const child of children) {
      if (typeof child === "string") parts.push(child);
      else if (child.name === "br") parts.push("\n");
      else visit(child.children);
    }
  };
  visit(nodes);
  return parts.join("");
}

/** Collapses spaces, trims each line, and drops leading and trailing blank lines. */
function normalizeInline(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .trim();
}

function prefixLines(text: string, prefix: string, blankPrefix: string, skipFirst = false): string {
  return text
    .split("\n")
    .map((line, i) => (skipFirst && i === 0 ? line : line ? prefix + line : blankPrefix))
    .join("\n");
}

function escapeUrl(url: string): string {
  return url.replace(/[\s()<>]/g, (char) => encodeURIComponent(char));
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// A Map, not an object literal: entity names come from untrusted HTML, and
// `&constructor;` must not resolve to an inherited property.
const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["bull", "•"],
  ["cent", "¢"],
  ["copy", "©"],
  ["deg", "°"],
  ["euro", "€"],
  ["gt", ">"],
  ["hellip", "…"],
  ["laquo", "«"],
  ["ldquo", "“"],
  ["lsquo", "‘"],
  ["lt", "<"],
  ["mdash", "—"],
  ["middot", "·"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["para", "¶"],
  ["pound", "£"],
  ["quot", '"'],
  ["raquo", "»"],
  ["rdquo", "”"],
  ["reg", "®"],
  ["rsquo", "’"],
  ["sect", "§"],
  ["times", "×"],
  ["trade", "™"],
  ["yen", "¥"],
]);

const ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY_PATTERN, (match, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? match;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : "\uFFFD";
  });
}

interface ElementNode {
  readonly name: string;
  readonly attrs: string;
  readonly children: Node[];
  hasBlock: boolean;
}

type Node = ElementNode | string;

const MAX_DEPTH = 128;

const MAX_PREFIX_DEPTH = 8;

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

export function convertHtmlToMarkdown(html: string): string {
  return renderBlocks(parseHtml(html).children, 0, []).join("\n\n");
}

function parseHtml(html: string): ElementNode {
  const root: ElementNode = { name: "#root", attrs: "", children: [], hasBlock: false };
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
    const isTagStart = isAsciiLetter(next) || next === 47;
    const isMarkup = next === 33 || next === 63;
    if (!isTagStart && !isMarkup) {
      pushText(open + 1);
      pos = open + 1;
      continue;
    }

    pushText(open);

    if (isMarkup) {
      const terminator = html.startsWith("<!--", open) ? "-->" : ">";
      const end = html.indexOf(terminator, open + 2);
      pos = end === -1 ? html.length : end + terminator.length;
      continue;
    }

    const close = findTagEnd(html, open + 1);
    if (close === -1) {
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
        current().children.push({ name, attrs: "", children: [], hasBlock: false });
      } else {
        closeElement(stack, name);
      }
      continue;
    }

    const selfClosing = source.charCodeAt(source.length - 1) === 47;
    if (SKIPPED_ELEMENTS.has(name)) {
      const foreign = name === "svg" || name === "math";
      if (!(foreign && selfClosing)) pos = skipRawText(html, name, pos);
      continue;
    }

    closeImplicitly(stack, name);
    const element: ElementNode = {
      name,
      attrs: source.slice(nameMatch[0].length),
      children: [],
      hasBlock: false,
    };
    current().children.push(element);
    if (BLOCK_ELEMENTS.has(name)) markBlockAncestors(stack);

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

function findTagEnd(html: string, from: number): number {
  let quote = 0;
  let previous = 0;
  for (let i = from; i < html.length; i++) {
    const code = html.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if ((code === 34 || code === 39) && previous === 61) {
      quote = code;
    } else if (code === 62) {
      return i;
    }
    if (code > 32) previous = code;
  }
  return -1;
}

function skipRawText(html: string, name: string, from: number): number {
  const pattern = new RegExp(`</${name}(?=[\\s/>])`, "gi");
  pattern.lastIndex = from;
  if (!pattern.exec(html)) return html.length;
  const end = html.indexOf(">", pattern.lastIndex);
  return end === -1 ? html.length : end + 1;
}

function markBlockAncestors(stack: ElementNode[]): void {
  for (let i = stack.length - 1; i > 0 && !stack[i]!.hasBlock; i--) {
    stack[i]!.hasBlock = true;
  }
}

function closeElement(stack: ElementNode[], name: string): void {
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i]!.name === name) {
      stack.length = i;
      return;
    }
  }
}

function closeImplicitly(stack: ElementNode[], name: string): void {
  if (name === "li") {
    closeWithin(stack, ["li"], LIST_ELEMENTS);
  } else if (name === "dt" || name === "dd") {
    closeWithin(stack, ["dt", "dd"], new Set(["dl"]));
  } else if (name === "tr") {
    closeWithin(stack, ["tr"], new Set(["table", "thead", "tbody", "tfoot"]));
  } else if (name === "td" || name === "th") {
    closeWithin(stack, ["td", "th"], new Set(["tr", "table"]));
  } else if (name === "thead" || name === "tbody" || name === "tfoot") {
    closeWithin(stack, ["thead", "tbody", "tfoot"], new Set(["table"]));
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

function renderBlocks(nodes: readonly Node[], depth: number, out: string[]): string[] {
  let inline: Node[] = [];

  const flush = () => {
    const text = normalizeInline(renderInline(inline));
    if (text) out.push(text);
    inline = [];
  };

  for (const node of nodes) {
    if (typeof node === "string" || !rendersAsBlock(node)) {
      inline.push(node);
      continue;
    }
    flush();
    renderBlockElement(node, depth, out);
  }
  flush();
  return out;
}

function rendersAsBlock(node: ElementNode): boolean {
  return BLOCK_ELEMENTS.has(node.name) || (node.hasBlock && node.name !== "a");
}

function renderBlockElement(node: ElementNode, depth: number, out: string[]): void {
  switch (node.name) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = normalizeInline(renderInline(node.children)).replace(/\n+/g, " ");
      if (text) out.push(`${"#".repeat(Number(node.name[1]))} ${text}`);
      return;
    }
    case "hr":
      out.push("---");
      return;
    case "pre":
      out.push(renderCodeBlock(node));
      return;
    case "blockquote": {
      if (depth >= MAX_PREFIX_DEPTH) {
        renderBlocks(node.children, depth, out);
        return;
      }
      const content = renderBlocks(node.children, depth + 1, []).join("\n\n");
      if (content) out.push(prefixLines(content, "> ", ">"));
      return;
    }
    case "ol":
    case "ul":
    case "dir":
    case "menu":
      renderList(node, depth, out);
      return;
    case "table":
      renderTable(node, depth, out);
      return;
    default:
      renderBlocks(node.children, depth, out);
  }
}

function renderList(node: ElementNode, depth: number, out: string[]): void {
  const start = node.name === "ol" ? readAttribute(node.attrs, "start") : undefined;
  let index = start !== undefined && /^\d{1,9}$/.test(start) ? Number(start) : 1;
  const items: string[] = [];

  for (const child of node.children) {
    const content = typeof child !== "string" && child.name === "li" ? child.children : [child];
    const marker = node.name === "ol" ? `${index}. ` : "- ";

    if (depth >= MAX_PREFIX_DEPTH) {
      const first = out.length;
      renderBlocks(content, depth, out);
      if (out.length > first) {
        out[first] = marker + out[first];
        index++;
      }
      continue;
    }

    const text = renderBlocks(content, depth + 1, []).join("\n");
    if (!text) continue;
    index++;
    items.push(marker + prefixLines(text, " ".repeat(marker.length), "", true));
  }
  if (items.length > 0) out.push(items.join("\n"));
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

function renderTable(node: ElementNode, depth: number, out: string[]): void {
  const rows: ElementNode[][] = [];
  const captions: ElementNode[] = [];

  const visit = (children: readonly Node[]) => {
    for (const child of children) {
      if (typeof child === "string") continue;
      if (child.name === "tr") {
        rows.push(
          child.children.filter(
            (cell): cell is ElementNode =>
              typeof cell !== "string" && (cell.name === "td" || cell.name === "th"),
          ),
        );
      } else if (child.name === "caption") {
        captions.push(child);
      } else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") {
        visit(child.children);
      }
    }
  };
  visit(node.children);

  if (rows.some((row) => row.some((cell) => cell.hasBlock))) {
    renderBlocks(node.children, depth, out);
    return;
  }

  const blocks: string[] = [];
  for (const caption of captions) renderBlocks(caption.children, depth, blocks);

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width > 0) {
    const line = (cells: readonly string[]) =>
      `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    const [header, ...body] = rows.map((row) =>
      row.map((cell) =>
        normalizeInline(renderInline(cell.children)).replace(/\n+/g, " ").replace(/\|/g, "\\|"),
      ),
    );
    blocks.push(
      [line(header!), line(Array.from({ length: width }, () => "---")), ...body.map(line)].join(
        "\n",
      ),
    );
  }
  if (blocks.length > 0) out.push(blocks.join("\n\n"));
}

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

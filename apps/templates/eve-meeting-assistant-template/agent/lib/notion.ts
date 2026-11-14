// A small Notion REST client for meeting notes. The meeting acts in Notion as
// one integration, not as each participant: participants are per-meeting
// principals with unverified names, so they can't sign in to Notion themselves.

const NOTION_API = "https://api.notion.com/v1";
// `after` in block appends needs this version; later versions renamed it.
const NOTION_VERSION = "2022-06-28";
const MAX_TEXT = 2_000;
const MAX_BLOCKS_PER_APPEND = 100;
const MAX_READ_PAGES = 5;

export interface NotionBlockInput {
  readonly object: "block";
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface NotionBlock {
  readonly id: string;
  readonly type: string;
  readonly has_children?: boolean;
  readonly [key: string]: unknown;
}

export interface NotionPage {
  readonly id: string;
  readonly url: string;
}

/** A readable block for the agent and the on-screen doc. */
export interface DocLine {
  readonly kind:
    | "h1"
    | "h2"
    | "h3"
    | "p"
    | "bullet"
    | "number"
    | "todo"
    | "quote"
    | "code"
    | "divider"
    | "page"
    | "callout";
  /** The block's id, for edits. */
  readonly id: string;
  /** The block's text as inline Markdown: `**bold**`, `*italic*`, `~~struck~~`, `` `code` ``, and `[links](url)`. */
  readonly text: string;
  readonly checked?: boolean;
}

async function notionToken(): Promise<string> {
  const local = process.env.NOTION_TOKEN?.trim();
  if (local) return local;
  const { getToken } = await import("@vercel/connect");
  const connector = process.env.NOTION_CONNECTOR?.trim();
  if (!connector) {
    throw new Error(
      "Set NOTION_CONNECTOR to the Vercel Connect connector for Notion (its UID from `vercel connect list`), or NOTION_TOKEN to an integration secret.",
    );
  }
  return await getToken(connector, {
    subject: { type: "app" },
  });
}

export async function notion<T>(
  path: string,
  init: { readonly method?: "GET" | "POST" | "PATCH" | "DELETE"; readonly body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${NOTION_API}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: `Bearer ${await notionToken()}`,
      "content-type": "application/json",
      "notion-version": NOTION_VERSION,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) {
    // Notion's error body names the problem, such as a page not shared with the integration.
    throw new Error(`Notion ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

export function parentPageId(): string {
  const id = process.env.NOTION_PARENT_PAGE_ID?.trim();
  if (!id) {
    throw new Error(
      "Set NOTION_PARENT_PAGE_ID to the Notion page meeting notes go under, and share that page with the integration (… > Connections).",
    );
  }
  return toPageId(id);
}

/** Accepts a page or block id, or any Notion URL that ends in one. */
export function toPageId(idOrUrl: string): string {
  const path = idOrUrl
    .trim()
    .replace(/[?#].*$/u, "")
    .replace(/-/gu, "");
  // A title before the id can end in hex letters, as in "Cafe", so keep the last 32.
  const run = path.match(/[0-9a-f]{32,}/giu)?.at(-1);
  if (!run) throw new Error(`"${idOrUrl}" isn't a Notion page id or link.`);
  return run.slice(-32).toLowerCase();
}

export async function createPage(input: {
  readonly parentId: string;
  readonly title: string;
  readonly children: readonly NotionBlockInput[];
}): Promise<NotionPage> {
  const page = await notion<NotionPage>("/pages", {
    body: {
      parent: { page_id: input.parentId },
      properties: { title: { title: richText(input.title) } },
      children: input.children.slice(0, MAX_BLOCKS_PER_APPEND),
    },
  });
  // Notion takes at most 100 children when it creates a page.
  const rest = input.children.slice(MAX_BLOCKS_PER_APPEND);
  if (rest.length > 0) await appendBlocks(page.id, rest);
  return page;
}

/** Appends blocks, after `after` when it's given, and returns the new blocks. */
export async function appendBlocks(
  parentId: string,
  children: readonly NotionBlockInput[],
  after?: string,
): Promise<NotionBlock[]> {
  const added: NotionBlock[] = [];
  let anchor = after;
  for (let i = 0; i < children.length; i += MAX_BLOCKS_PER_APPEND) {
    const { results } = await notion<{ results: NotionBlock[] }>(`/blocks/${parentId}/children`, {
      method: "PATCH",
      body: {
        children: children.slice(i, i + MAX_BLOCKS_PER_APPEND),
        ...(anchor !== undefined && { after: anchor }),
      },
    });
    added.push(...results);
    anchor = results.at(-1)?.id ?? anchor;
  }
  return added;
}

export async function updateBlock(blockId: string, body: Record<string, unknown>): Promise<void> {
  await notion(`/blocks/${blockId}`, { method: "PATCH", body });
}

export async function deleteBlock(blockId: string): Promise<void> {
  await notion(`/blocks/${blockId}`, { method: "DELETE" });
}

export async function getBlock(
  blockId: string,
): Promise<NotionBlock & { parent?: { page_id?: string; block_id?: string } }> {
  return await notion(`/blocks/${blockId}`);
}

/**
 * The link the meeting bot can open without signing in: the published site's
 * link when the page is published, else its own link, which works when the
 * page or a parent is shared with anyone who has the link.
 */
export async function viewUrl(pageId: string): Promise<string> {
  const page = await notion<NotionPage & { public_url?: string | null }>(`/pages/${pageId}`);
  return page.public_url ?? page.url;
}

/** The ids of a block's first children, in order. */
export async function readChildIds(blockId: string): Promise<string[]> {
  const { results } = await notion<{ results: NotionBlock[] }>(
    `/blocks/${blockId}/children?page_size=20`,
  );
  return results.map((child) => child.id);
}

export async function readPage(
  pageId: string,
): Promise<{ title: string; url: string; lines: DocLine[] }> {
  const page = await notion<NotionPage & { properties?: Record<string, unknown> }>(
    `/pages/${pageId}`,
  );
  const lines: DocLine[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_READ_PAGES; i++) {
    const query = new URLSearchParams({
      page_size: "100",
      ...(cursor && { start_cursor: cursor }),
    });
    const batch = await notion<{
      results: NotionBlock[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/blocks/${pageId}/children?${query}`);
    for (const block of batch.results) {
      const line = toDocLine(block);
      if (line) lines.push(line);
    }
    if (!batch.has_more || !batch.next_cursor) break;
    cursor = batch.next_cursor;
  }
  return { title: pageTitle(page.properties), url: page.url, lines };
}

export async function searchPages(query: string, limit = 8) {
  const { results } = await notion<{
    results: (NotionPage & { last_edited_time: string; properties?: Record<string, unknown> })[];
  }>("/search", {
    body: {
      query,
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: limit,
    },
  });
  return results.map((page) => ({
    id: page.id,
    title: pageTitle(page.properties),
    url: page.url,
    lastEdited: page.last_edited_time,
  }));
}

interface RichTextInput {
  readonly type: "text";
  readonly text: { readonly content: string; readonly link?: { readonly url: string } };
  readonly annotations?: Partial<Record<"bold" | "italic" | "strikethrough" | "code", boolean>>;
}

/** Plain text, such as a title, split into Notion's 2,000-character pieces. */
export function richText(text: string): RichTextInput[] {
  return inlineMarkdown(text.replace(/[*_~`[\]]/gu, (char) => `\\${char}`));
}

/** Notion rich text from inline Markdown: `**bold**`, `*italic*`, `~~struck~~`, `` `code` ``, and `[links](url)`. */
export function inlineMarkdown(text: string): RichTextInput[] {
  const parts: RichTextInput[] = [];
  const push = (
    content: string,
    extra: Omit<RichTextInput, "type" | "text"> & { url?: string } = {},
  ) => {
    const { url, ...rest } = extra;
    for (let i = 0; i < content.length; i += MAX_TEXT) {
      const piece = content.slice(i, i + MAX_TEXT);
      parts.push({
        type: "text",
        text: { content: piece, ...(url && { link: { url } }) },
        ...rest,
      });
    }
  };
  const pattern =
    /\\([*_~`[\]])|`([^`]+)`|\*\*(.+?)\*\*|~~(.+?)~~|(?<![\w*])[*_](?![\s*_])(.+?)(?<![\s*_])[*_](?![\w*])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu;
  let plain = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    plain += text.slice(last, match.index);
    last = match.index + match[0].length;
    const [, escaped, code, bold, strike, italic, label, url] = match;
    if (escaped !== undefined) {
      plain += escaped;
      continue;
    }
    if (plain) push(plain);
    plain = "";
    if (code !== undefined) push(code, { annotations: { code: true } });
    else if (bold !== undefined) push(bold, { annotations: { bold: true } });
    else if (strike !== undefined) push(strike, { annotations: { strikethrough: true } });
    else if (italic !== undefined) push(italic, { annotations: { italic: true } });
    else push(label!, { url: url! });
  }
  plain += text.slice(last);
  if (plain) push(plain);
  return parts.length > 0 ? parts : [{ type: "text", text: { content: "" } }];
}

/** A block whose text is inline Markdown. */
export function block(
  type: string,
  text: string,
  extra: Record<string, unknown> = {},
): NotionBlockInput {
  return { object: "block", type, [type]: { rich_text: inlineMarkdown(text), ...extra } };
}

/** Converts the Markdown the model writes into Notion blocks, one per line. */
export function markdownToBlocks(markdown: string): NotionBlockInput[] {
  const blocks: NotionBlockInput[] = [];
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (line.startsWith("```")) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      // Code stays literal: no inline Markdown inside it.
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: richText(code.join("\n")), language: "plain text" },
      });
      continue;
    }
    const match =
      /^(#{1,3}) (.*)$/u.exec(line) ??
      /^\s*[-*] \[([ xX])\] (.*)$/u.exec(line) ??
      /^\s*([-*]) (.*)$/u.exec(line) ??
      /^\s*(\d+)[.)] (.*)$/u.exec(line) ??
      /^(>) ?(.*)$/u.exec(line);
    if (line.trim() === "") continue;
    if (/^-{3,}$/u.test(line.trim())) {
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else if (!match) {
      blocks.push(block("paragraph", line));
    } else {
      const [, marker = "", text = ""] = match;
      if (marker.startsWith("#")) blocks.push(block(`heading_${marker.length}`, text));
      else if (marker === "-" || marker === "*") blocks.push(block("bulleted_list_item", text));
      else if (marker === ">") blocks.push(block("quote", text));
      else if (/^\d+$/u.test(marker)) blocks.push(block("numbered_list_item", text));
      else blocks.push(block("to_do", text, { checked: marker !== " " }));
    }
  }
  return blocks;
}

/** Each line as Markdown, in order. */
export function docLinesToMarkdown(lines: readonly DocLine[]): string[] {
  let number = 0;
  return lines.map((line) => {
    number = line.kind === "number" ? number + 1 : 0;
    switch (line.kind) {
      case "h1":
        return `# ${line.text}`;
      case "h2":
        return `## ${line.text}`;
      case "h3":
        return `### ${line.text}`;
      case "bullet":
        return `- ${line.text}`;
      case "number":
        return `${number}. ${line.text}`;
      case "todo":
        return `- [${line.checked ? "x" : " "}] ${line.text}`;
      case "quote":
      case "callout":
        return `> ${line.text}`;
      case "code":
        return `\`\`\`\n${line.text}\n\`\`\``;
      case "divider":
        return "---";
      case "page":
        return `[Subpage] ${line.text}`;
      case "p":
        return line.text;
    }
  });
}

const DOC_KINDS: Record<string, DocLine["kind"]> = {
  heading_1: "h1",
  heading_2: "h2",
  heading_3: "h3",
  paragraph: "p",
  bulleted_list_item: "bullet",
  numbered_list_item: "number",
  to_do: "todo",
  quote: "quote",
  code: "code",
  callout: "callout",
  divider: "divider",
  child_page: "page",
};

interface RichTextPart {
  readonly plain_text?: string;
  readonly href?: string | null;
  readonly annotations?: Partial<Record<"bold" | "italic" | "strikethrough" | "code", boolean>>;
}

/** Inline Markdown for Notion rich text, the inverse of {@link inlineMarkdown}. */
function toInlineMarkdown(parts: readonly RichTextPart[], literal: boolean): string {
  return parts
    .map((part) => {
      let text = part.plain_text ?? "";
      if (literal) return text;
      const { bold, italic, strikethrough, code } = part.annotations ?? {};
      if (code) return `\`${text}\``;
      text = text.replace(/[*_~`[\]]/gu, (char) => `\\${char}`);
      if (bold) text = `**${text}**`;
      if (italic) text = `*${text}*`;
      if (strikethrough) text = `~~${text}~~`;
      if (part.href) text = `[${text}](${part.href})`;
      return text;
    })
    .join("");
}

function toDocLine(block: NotionBlock): DocLine | undefined {
  const kind = DOC_KINDS[block.type];
  if (!kind) return undefined;
  const body = block[block.type] as
    | { rich_text?: RichTextPart[]; checked?: boolean; title?: string }
    | undefined;
  const text = body?.title ?? toInlineMarkdown(body?.rich_text ?? [], kind === "code");
  if (kind === "p" && text === "") return undefined;
  return { id: block.id, kind, text, ...(kind === "todo" && { checked: body?.checked === true }) };
}

function pageTitle(properties: Record<string, unknown> | undefined): string {
  for (const value of Object.values(properties ?? {})) {
    const property = value as { type?: string; title?: { plain_text?: string }[] };
    if (property.type === "title")
      return property.title?.map((part) => part.plain_text ?? "").join("") ?? "";
  }
  return "Untitled";
}

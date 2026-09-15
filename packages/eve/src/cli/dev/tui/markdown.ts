import { lexer, type TableCell, type Token } from "#compiled/marked/index.js";

import { sliceVisible, stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";
import { graphemes } from "#shared/text-boundaries.js";

type TableAlignment = "left" | "center" | "right";

const ansi = {
  bold: "\x1b[1m",
  boldOff: "\x1b[22m",
  inlineCode: "\x1b[38;5;245m",
  inlineCodeOff: "\x1b[39m",
  dim: "\x1b[2m",
  dimOff: "\x1b[22m",
  italic: "\x1b[3m",
  italicOff: "\x1b[23m",
  strike: "\x1b[9m",
  strikeOff: "\x1b[29m",
  underline: "\x1b[4m",
  underlineOff: "\x1b[24m",
};

const tableSeparator = "─";
const tableColumnSeparator = " │ ";
const tableBorderWidth = 3;
const maxLinkUrlBytes = 2083;

/**
 * Whether prose responses should be parsed and styled as Markdown.
 * `EVE_TUI_RENDER_MARKDOWN=0` bypasses Markdown parsing and styling.
 */
export function detectMarkdownRendering(env?: {
  readonly EVE_TUI_RENDER_MARKDOWN?: string;
}): boolean {
  const override = env?.EVE_TUI_RENDER_MARKDOWN ?? process.env.EVE_TUI_RENDER_MARKDOWN;
  if (override === "0" || override === "false") return false;
  return true;
}

/** Renders parsed GFM blocks for terminal presentation. */
export function renderMarkdown(input: string, width = Number.POSITIVE_INFINITY): string {
  return trimTrailingBlankRows(renderBlocks(lexer(input), width, true)).join("\n");
}

function renderBlocks(tokens: readonly Token[], width: number, separateBlocks = false): string[] {
  const rows: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        pushBlankRow(rows);
        break;
      case "heading":
        rows.push(renderHeading(token.depth ?? 1, token.tokens));
        break;
      case "paragraph":
      case "text":
        rows.push(...renderInline(token.tokens, token.text).split("\n"));
        break;
      case "code":
        rows.push(...renderCodeBlock(token, width));
        break;
      case "blockquote":
        rows.push(
          ...renderBlocks(token.tokens ?? [], Math.max(1, width - 2)).map(
            (row) => `${ansi.dim}│${ansi.dimOff} ${row}`,
          ),
        );
        break;
      case "list":
        rows.push(...renderList(token, width));
        break;
      case "table":
        rows.push(...renderTable(token, width));
        break;
      case "hr":
        rows.push(ansi.dim + tableSeparator.repeat(horizontalRuleWidth(width)) + ansi.dimOff);
        break;
      case "html":
        rows.push(...(token.text ?? token.raw ?? "").split("\n"));
        break;
      case "def":
        break;
      default:
        if (token.tokens !== undefined) {
          rows.push(...renderBlocks(token.tokens, width));
        } else if (token.text !== undefined) {
          rows.push(token.text);
        }
        break;
    }
    if (separateBlocks && isVisibleBlock(token)) pushBlankRow(rows);
  }
  return rows;
}

function isVisibleBlock(token: Token): boolean {
  return token.type !== "space" && token.type !== "def";
}

function renderHeading(depth: number, tokens: readonly Token[] | undefined): string {
  const underlined = depth === 1 || depth === 3 || depth === 5;
  const bold = depth === 1 || depth === 2 || depth === 4;
  const dim = depth === 4 || depth === 5 || depth >= 6;
  const content = renderInline(tokens, "", {
    restoreAfterStrong: dim && !bold ? ansi.dim : "",
    restoreUnderlineAfterLink: underlined,
    suppressBold: bold,
  });
  switch (depth) {
    case 1:
      return `${ansi.bold}${ansi.underline}${content}${ansi.underlineOff}${ansi.boldOff}`;
    case 2:
      return `${ansi.bold}${content}${ansi.boldOff}`;
    case 3:
      return `${ansi.underline}${content}${ansi.underlineOff}`;
    case 4:
      return `${ansi.bold}${ansi.dim}${content}${ansi.boldOff}`;
    case 5:
      return `${ansi.dim}${ansi.underline}${content}${ansi.underlineOff}${ansi.dimOff}`;
    default:
      return `${ansi.dim}${content}${ansi.dimOff}`;
  }
}

function renderCodeBlock(token: Token, width: number): string[] {
  const language = token.lang?.trim() ?? "";
  const codeRows = (token.text ?? "").replace(/\n$/u, "").split("\n");
  const codeWidth = Math.max(1, ...codeRows.map(visibleLength));
  if (!Number.isFinite(width) || width > 5) {
    const panelWidth = Math.min(
      Number.isFinite(width) ? Math.floor(width) : codeWidth,
      Math.max(6, codeWidth, visibleLength(language) + 4),
    );
    const header =
      language.length > 0 ? codePanelHeader(language, panelWidth) : codePanelRule(panelWidth);
    return [
      header,
      ...codeRows.flatMap((row) => wrapCodeRow(row, panelWidth)),
      codePanelRule(panelWidth),
    ];
  }
  return codeRows.flatMap((row) => wrapCodeRow(row, Math.max(1, Math.floor(width))));
}

function codePanelHeader(language: string, width: number): string {
  const label = sliceVisible(language, Math.max(1, width - 4)) || "?";
  return `${ansi.dim}─ ${label} ${tableSeparator.repeat(Math.max(0, width - 3 - visibleLength(label)))}${ansi.dimOff}`;
}

function codePanelRule(width: number): string {
  return `${ansi.dim}${tableSeparator.repeat(width)}${ansi.dimOff}`;
}

function wrapCodeRow(row: string, width: number): string[] {
  if (row.length === 0) return [""];
  const indent = row.match(/^[\t ]*/u)?.[0] ?? "";
  const rows: string[] = [];
  let remaining = row;
  let continuation = false;
  while (remaining.length > 0) {
    const prefix = continuation && visibleLength(indent) < width ? indent : "";
    const available = Math.max(1, width - visibleLength(prefix));
    const fitting = sliceVisible(remaining, available);
    const fallback = fitting.length === 0 ? firstGraphemeFallback(remaining) : undefined;
    const content = fallback?.rendered ?? fitting;
    rows.push(`${prefix}${content}`);
    remaining = remaining.slice(fallback?.consumed ?? fitting.length);
    continuation = true;
  }
  return rows;
}

function renderList(token: Token, width: number): string[] {
  const rows: string[] = [];
  let ordinal = typeof token.start === "number" ? token.start : 1;
  for (const item of token.items ?? []) {
    const marker = token.ordered
      ? `${ansi.dim}${ordinal}.${ansi.dimOff}`
      : `${ansi.dim}•${ansi.dimOff}`;
    const markerWidth = token.ordered ? `${ordinal}.`.length : 1;
    const task = item.checked === true ? "✓ " : item.checked === false ? "☐ " : "";
    const itemRows = renderBlocks(item.tokens ?? [], Math.max(1, width - markerWidth - 1));
    const nonemptyRows = itemRows.length === 0 ? [""] : itemRows;
    nonemptyRows.forEach((row, index) => {
      rows.push(index === 0 ? `${marker} ${task}${row}` : `${" ".repeat(markerWidth + 1)}${row}`);
    });
    ordinal += 1;
  }
  return rows;
}

interface InlineOptions {
  readonly restoreAfterStrong?: string;
  readonly restoreUnderlineAfterLink?: boolean;
  readonly suppressBold?: boolean;
}

function renderInline(
  tokens: readonly Token[] | undefined,
  fallback = "",
  options: InlineOptions = {},
): string {
  if (tokens === undefined) return fallback;

  let rendered = "";
  for (const token of tokens) {
    // Keep the introducing word with an image label so normal word wrapping
    // cannot leave the image alone.
    if (token.type === "image" && rendered.endsWith(" ")) {
      rendered = `${rendered.slice(0, -1)}\u00a0`;
    }
    rendered += renderInlineToken(token, options);
  }
  return rendered;
}

function renderInlineToken(token: Token, options: InlineOptions): string {
  switch (token.type) {
    case "text":
      return renderInline(token.tokens, token.text ?? "", options);
    case "strong": {
      const content = renderInline(token.tokens, token.text, options);
      return options.suppressBold
        ? content
        : `${ansi.bold}${content}${ansi.boldOff}${options.restoreAfterStrong ?? ""}`;
    }
    case "em":
      return `${ansi.italic}${renderInline(token.tokens, token.text, options)}${ansi.italicOff}`;
    case "del":
      return `${ansi.strike}${renderInline(token.tokens, token.text, options)}${ansi.strikeOff}`;
    case "codespan":
      return `${ansi.inlineCode}${token.text ?? ""}${ansi.inlineCodeOff}`;
    case "link":
      return renderLink(
        renderInline(token.tokens, token.text, options),
        token.href ?? "",
        options.restoreUnderlineAfterLink,
      );
    case "image":
      return renderLink(
        `▧\u00a0${(token.text?.trim() || "image").replaceAll(" ", "\u00a0")}`,
        token.href ?? "",
        options.restoreUnderlineAfterLink,
      );
    case "br":
      return "\n";
    case "checkbox":
      return token.checked ? "✓ " : "☐ ";
    case "escape":
      return token.text ?? "";
    case "html":
      return token.text ?? token.raw ?? "";
    default:
      return renderInline(token.tokens, token.text ?? token.raw ?? "", options);
  }
}

function renderLink(label: string, href: string, restoreUnderline = false): string {
  if (!isSafeLinkUrl(href)) return label;
  const restore = restoreUnderline ? ansi.underline : "";
  return `\x1b]8;;${href}\x1b\\${ansi.underline}${label}${ansi.underlineOff}\x1b]8;;\x1b\\${restore}`;
}

function isSafeLinkUrl(href: string): boolean {
  return (
    href.length > 0 &&
    Buffer.byteLength(href, "utf8") <= maxLinkUrlBytes &&
    [...href].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f && (codePoint < 0x80 || codePoint > 0x9f);
    })
  );
}

function renderTable(token: Token, width: number): string[] {
  const header = token.header ?? [];
  if (header.length === 0) return [];
  const alignments = header.map((_, index) => normalizeAlignment(token.align?.[index]));
  const renderedHeader = header.map(renderTableCell);
  const renderedRows = (token.rows ?? []).map((row) =>
    normalizeTableRow(row, header.length).map(renderTableCell),
  );
  const allRows = [renderedHeader, ...renderedRows];
  const widths = alignments.map((_, column) =>
    Math.max(1, ...allRows.map((row) => visibleLength(row[column] ?? ""))),
  );
  const gridWidth =
    widths.reduce((sum, columnWidth) => sum + columnWidth, 0) +
    widths.length * tableBorderWidth +
    1;
  if (widths.length > 0 && (!Number.isFinite(width) || gridWidth <= width)) {
    const boldHeader = renderedHeader.map((cell) => `${ansi.bold}${cell}${ansi.boldOff}`);
    return [
      formatTableBorder(widths, "┌", "┬", "┐"),
      formatBoxedTableRow(boldHeader, widths, alignments),
      formatTableBorder(widths, "├", "┼", "┤"),
      ...renderedRows.flatMap((row, index) => [
        formatBoxedTableRow(row, widths, alignments),
        ...(index + 1 < renderedRows.length ? [formatTableBorder(widths, "├", "┼", "┤")] : []),
      ]),
      formatTableBorder(widths, "└", "┴", "┘"),
    ];
  }
  return renderVerticalTable(renderedHeader, renderedRows, width);
}

function renderTableCell(cell: TableCell): string {
  return renderInline(cell.tokens, cell.text).replaceAll("\n", " ");
}

function normalizeTableRow(row: readonly TableCell[], length: number): TableCell[] {
  return Array.from({ length }, (_, index) => row[index] ?? { text: "", tokens: [] });
}

function normalizeAlignment(value: "center" | "left" | "right" | null | undefined): TableAlignment {
  return value ?? "left";
}

function renderVerticalTable(
  header: readonly string[],
  rows: readonly string[][],
  width: number,
): string[] {
  const availableWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  if (availableWidth <= 2) return renderNarrowTable(header, rows, availableWidth);

  const innerWidth = availableWidth - 2;
  const rule = `${ansi.dim}┌${tableSeparator.repeat(innerWidth)}┐${ansi.dimOff}`;
  const divider = `${ansi.dim}├${tableSeparator.repeat(innerWidth)}┤${ansi.dimOff}`;
  const bottom = `${ansi.dim}└${tableSeparator.repeat(innerWidth)}┘${ansi.dimOff}`;
  const output = [rule];
  rows.forEach((row, rowIndex) => {
    header.forEach((name, column) => {
      output.push(...boxedTableLines(`${name}: ${row[column] ?? ""}`, innerWidth));
    });
    if (rowIndex + 1 < rows.length) output.push(divider);
  });
  output.push(bottom);
  return output;
}

function renderNarrowTable(
  header: readonly string[],
  rows: readonly string[][],
  width: number,
): string[] {
  return rows.flatMap((row) =>
    header.map((name, column) => {
      const content = stripAnsi(`${name}: ${row[column] ?? ""}`);
      const fitting = sliceVisible(content, width);
      return fitting.length > 0 ? fitting : firstGraphemeFallback(content).rendered;
    }),
  );
}

function boxedTableLines(content: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = content;
  do {
    const fitting = sliceVisible(remaining, width);
    const fallback = fitting.length === 0 ? firstGraphemeFallback(remaining) : undefined;
    const prefix = fallback?.rendered ?? fitting;
    const padding = " ".repeat(Math.max(0, width - visibleLength(prefix)));
    lines.push(`${ansi.dim}│${ansi.dimOff}${prefix}${padding}${ansi.dim}│${ansi.dimOff}`);
    remaining = remaining.slice(fallback?.consumed ?? fitting.length);
  } while (remaining.length > 0);
  return lines;
}

function firstGraphemeFallback(text: string): { consumed: number; rendered: string } {
  const first = graphemes(text)[0];
  return { consumed: first?.text.length ?? 1, rendered: "?" };
}

function formatTableBorder(
  widths: readonly number[],
  left: string,
  middle: string,
  right: string,
): string {
  return `${left}${widths.map((width) => tableSeparator.repeat(width + 2)).join(middle)}${right}`;
}

function formatBoxedTableRow(
  row: readonly string[],
  widths: readonly number[],
  alignments: readonly TableAlignment[],
): string {
  return `│ ${row
    .map((cell, index) => alignTableCell(cell, widths[index] ?? 1, alignments[index] ?? "left"))
    .join(tableColumnSeparator)} │`;
}

function alignTableCell(cell: string, width: number, alignment: TableAlignment): string {
  const paddingWidth = Math.max(0, width - visibleLength(cell));
  if (alignment === "right") return `${" ".repeat(paddingWidth)}${cell}`;
  if (alignment === "center") {
    const leftPadding = Math.floor(paddingWidth / 2);
    return `${" ".repeat(leftPadding)}${cell}${" ".repeat(paddingWidth - leftPadding)}`;
  }
  return `${cell}${" ".repeat(paddingWidth)}`;
}

function horizontalRuleWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 60;
}

function pushBlankRow(rows: string[]): void {
  if (rows.length > 0 && rows.at(-1) !== "") rows.push("");
}

function trimTrailingBlankRows(rows: string[]): string[] {
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

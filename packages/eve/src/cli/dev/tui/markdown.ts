import { lexer, type TableCell, type Token } from "#compiled/marked/index.js";

import { sliceVisible, visibleLength } from "#cli/ui/terminal-text.js";

type TableAlignment = "left" | "center" | "right";

const ansi = {
  bold: "\x1b[1m",
  boldOff: "\x1b[22m",
  cyan: "\x1b[36m",
  cyanOff: "\x1b[39m",
  dim: "\x1b[2m",
  dimOff: "\x1b[22m",
  italic: "\x1b[3m",
  italicOff: "\x1b[23m",
  strike: "\x1b[9m",
  strikeOff: "\x1b[29m",
};

const tableSeparator = "─";

/** Renders parsed GFM blocks to terminal text, fitting tables to `width`. */
export function renderMarkdown(input: string, width = Number.POSITIVE_INFINITY): string {
  return trimTrailingBlankRows(renderBlocks(lexer(input), width)).join("\n");
}

function renderBlocks(tokens: readonly Token[], width: number): string[] {
  const rows: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        pushBlankRow(rows);
        break;
      case "heading": {
        const glyph = token.depth === 1 ? "█" : token.depth === 2 ? "■" : "▶";
        rows.push(`${glyph} ${ansi.bold}${renderInline(token.tokens)}${ansi.boldOff}`);
        break;
      }
      case "paragraph":
      case "text":
        rows.push(...renderInline(token.tokens, token.text).split("\n"));
        break;
      case "code":
        rows.push(...renderCodeBlock(token));
        break;
      case "blockquote":
        rows.push(
          ...renderBlocks(token.tokens ?? [], Math.max(8, width - 2)).map(
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
  }
  return rows;
}

function renderCodeBlock(token: Token): string[] {
  const rows: string[] = [];
  if (token.lang?.trim()) rows.push(`  ${ansi.dim}${token.lang.trim()}${ansi.dimOff}`);
  const codeRows = (token.text ?? "").replace(/\n$/u, "").split("\n");
  for (const row of codeRows) {
    rows.push(`${ansi.dim}│${ansi.dimOff} ${ansi.cyan}${row}${ansi.cyanOff}`);
  }
  return rows;
}

function renderList(token: Token, width: number): string[] {
  const rows: string[] = [];
  let ordinal = typeof token.start === "number" ? token.start : 1;
  for (const item of token.items ?? []) {
    const marker = token.ordered ? `${ordinal}.` : "•";
    const task = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
    const itemRows = renderBlocks(item.tokens ?? [], Math.max(8, width - marker.length - 1));
    const nonemptyRows = itemRows.length === 0 ? [""] : itemRows;
    nonemptyRows.forEach((row, index) => {
      rows.push(index === 0 ? `${marker} ${task}${row}` : `${" ".repeat(marker.length + 1)}${row}`);
    });
    ordinal += 1;
  }
  return rows;
}

function renderInline(tokens: readonly Token[] | undefined, fallback = ""): string {
  if (tokens === undefined) return fallback;
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "text":
      return renderInline(token.tokens, token.text ?? "");
    case "strong":
      return `${ansi.bold}${renderInline(token.tokens, token.text)}${ansi.boldOff}`;
    case "em":
      return `${ansi.italic}${renderInline(token.tokens, token.text)}${ansi.italicOff}`;
    case "del":
      return `${ansi.strike}${renderInline(token.tokens, token.text)}${ansi.strikeOff}`;
    case "codespan":
      return `${ansi.cyan}${token.text ?? ""}${ansi.cyanOff}`;
    case "link": {
      const label = renderInline(token.tokens, token.text);
      const href = token.href ?? "";
      if (href.length === 0 || label === href) return `${ansi.cyan}${label}${ansi.cyanOff}`;
      return `${label} (${ansi.cyan}${href}${ansi.cyanOff})`;
    }
    case "image": {
      const label = token.text?.trim() || "image";
      const href = token.href ?? "";
      return href.length === 0 ? `[${label}]` : `[${label}] (${ansi.cyan}${href}${ansi.cyanOff})`;
    }
    case "br":
      return "\n";
    case "checkbox":
      return token.checked ? "☑ " : "☐ ";
    case "escape":
      return token.text ?? "";
    case "html":
      return token.text ?? token.raw ?? "";
    default:
      return renderInline(token.tokens, token.text ?? token.raw ?? "");
  }
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
    Math.max(3, ...allRows.map((row) => visibleLength(row[column] ?? ""))),
  );
  fitTableWidths(widths, width);

  const boldHeader = renderedHeader.map((cell) => `${ansi.bold}${cell}${ansi.boldOff}`);
  return [
    formatTableRow(boldHeader, widths, alignments),
    widths.map((columnWidth) => tableSeparator.repeat(columnWidth)).join("  "),
    ...renderedRows.map((row) => formatTableRow(row, widths, alignments)),
  ];
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

function fitTableWidths(widths: number[], width: number): void {
  if (!Number.isFinite(width)) return;
  const separators = Math.max(0, widths.length - 1) * 2;
  const budget = Math.max(widths.length * 3, Math.floor(width) - separators);
  while (widths.reduce((sum, value) => sum + value, 0) > budget) {
    const widest = Math.max(...widths);
    const index = widths.findIndex((value) => value === widest && value > 3);
    if (index === -1) return;
    widths[index] = widest - 1;
  }
}

function formatTableRow(
  row: readonly string[],
  widths: readonly number[],
  alignments: readonly TableAlignment[],
): string {
  return row
    .map((cell, index) =>
      alignTableCell(
        fitTableCell(cell, widths[index] ?? 3),
        widths[index] ?? 3,
        alignments[index] ?? "left",
      ),
    )
    .join("  ");
}

function fitTableCell(cell: string, width: number): string {
  if (visibleLength(cell) <= width) return cell;
  return `${sliceVisible(cell, Math.max(1, width - 1))}…`;
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
  return Number.isFinite(width) ? Math.max(3, Math.min(40, Math.floor(width))) : 40;
}

function pushBlankRow(rows: string[]): void {
  if (rows.length > 0 && rows.at(-1) !== "") rows.push("");
}

function trimTrailingBlankRows(rows: string[]): string[] {
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

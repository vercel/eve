/**
 * Renders a tool block's terminal rows: the indented header (status glyph,
 * verb-bold title, summarized args), the `│`-railed detail region —
 * aggregated batch items or a write's diffed content — closed by a `└`
 * corner, and the settled result line. Split from `blocks.ts` so the block
 * model and its per-kind renderers stay separable concerns.
 */

import type { DisplayBlock, RenderBlockContext, ToolGroupItem, ToolStatus } from "./blocks.js";
import type { ToolDetailLine } from "./line-diff.js";
import type { Theme } from "./theme.js";
import { formatValuePretty, truncate } from "./tool-format.js";
import { elisionText } from "./rail.js";
import { clipVisible, visibleLength, wrapVisibleLine } from "#cli/ui/terminal-text.js";

export function renderTool(
  block: DisplayBlock,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  // Top-level tool rows sit one extra level in so their marks start at the
  // prose text column (the character after the `│`/`▲` gutter). Nested
  // subagent rows keep the tighter lead inside their section's rail.
  if ((block.depth ?? 0) === 0) {
    // One cell here plus the row's own one-cell indent lands the mark at
    // the shared tool column.
    return renderToolRows(block, width - 1, theme, context).map((row) => ` ${row}`);
  }
  return renderToolRows(block, width, theme, context);
}

function renderToolRows(
  block: DisplayBlock,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  const { icon, accent } = toolGlyph(block.status ?? "running", theme, context);
  const name =
    block.status === "done" && block.doneTitle !== undefined
      ? block.doneTitle
      : (block.title ?? "tool");
  // The header is indented one cell so its glyph shares a column with the
  // `│`/`└` rail beneath it.
  const headerWidth = width - 3;
  const namePlain = clipVisible(name, headerWidth);
  let header = ` ${icon} ${boldLeadingWord(namePlain, theme)}`;
  const argsBudget = headerWidth - namePlain.length - 2;
  const args = block.subtitle ?? "";
  if (args.length > 0 && argsBudget >= 6) {
    header += `  ${theme.colors.gray(truncate(args, argsBudget))}`;
  }

  const rows = [header];

  // Detail region: `│`-railed rows closed by a `└` corner. Group items and
  // write bodies share the rail so every accumulating tool reads the same.
  const railRows: string[] = [];
  if (block.toolGroupItems !== undefined) {
    railRows.push(...toolGroupItemRows(block.toolGroupItems, width, theme));
  } else if (!block.expanded && showToolDetail(block)) {
    railRows.push(...detailLineRows(block.detailLines ?? [], width, theme));
  }
  if (railRows.length > 0) {
    rows.push(...railRows, ` ${theme.colors.dim(theme.glyph.corner)}`);
  }

  if (block.expanded) {
    rows.push(...renderToolExpanded(block, width, theme));
  } else if (block.status === "done" && block.result && block.result.length > 0) {
    rows.push(resultLine(theme.glyph.arrow, block.result, width, theme, accent));
  } else if (block.status === "error" && block.result) {
    // The failure summary hangs on a corner aligned under the title text,
    // reading as the call's closing line rather than a returned value.
    rows.push(errorDetailLine(block.result, width, theme));
  } else if (block.status === "denied") {
    rows.push(resultLine(theme.glyph.arrow, "denied", width, theme, theme.colors.yellow));
  }

  return rows;
}

/**
 * Only the verb carries the header's weight: `Ran find /workspace …` reads
 * as a bold action with its argument dimmed behind it, not one long banner.
 */
function boldLeadingWord(text: string, theme: Theme): string {
  const split = text.indexOf(" ");
  if (split === -1) return theme.colors.bold(text);
  return `${theme.colors.bold(text.slice(0, split))}${theme.colors.dim(text.slice(split))}`;
}

/** Detail stays up while the call runs; after settling only writes keep it. */
function showToolDetail(block: DisplayBlock): boolean {
  if (block.detailLines === undefined || block.detailLines.length === 0) return false;
  const status = block.status ?? "running";
  if (status === "running" || status === "approval") return true;
  return block.keepDetailWhenDone === true;
}

/**
 * An aggregated tool row lists at most this many member items; the rest
 * collapse into a single `… (N more)` line above the closing corner.
 */
export const maxVisibleToolGroupItems = 5;

/** A write's visible content is windowed to this many rail rows. */
const maxVisibleToolDetailLines = 10;

function railRow(body: string, theme: Theme): string {
  return ` ${theme.colors.dim(theme.glyph.rule)} ${body}`;
}

function elisionRow(hidden: number, theme: Theme): string {
  return railRow(elisionText(hidden, theme), theme);
}

function toolGroupItemRows(items: readonly ToolGroupItem[], width: number, theme: Theme): string[] {
  const visible = items.slice(0, maxVisibleToolGroupItems);
  const hidden = items.length - visible.length;
  const rows = itemRows(visible, width, theme);
  if (hidden > 0) {
    rows.push(elisionRow(hidden, theme));
  }
  return rows;
}

function detailLineRows(lines: readonly ToolDetailLine[], width: number, theme: Theme): string[] {
  const c = theme.colors;
  const visible = lines.slice(0, maxVisibleToolDetailLines);
  const hidden = lines.length - visible.length;
  // A region with changes gets a marker column so `+`/`-` rows and their
  // context stay aligned; plain content keeps the tighter rail.
  const hasDiff = visible.some((line) => line.kind === "added" || line.kind === "removed");
  const budget = Math.max(1, width - (hasDiff ? 5 : 4));

  // Content lines clip rather than wrap: file bodies read best one row per
  // logical line, and the window cap already bounds the region's height.
  const rows = visible.map((line) => {
    if (line.kind === "gap") {
      return railRow(c.dim(theme.glyph.ellipsis), theme);
    }
    const text = clipVisible(line.text, budget);
    switch (line.kind) {
      case "added":
        return ` ${c.dim(theme.glyph.rule)}${c.green("+")} ${c.green(text)}`;
      case "removed":
        return ` ${c.dim(theme.glyph.rule)}${c.red("-")} ${c.red(text)}`;
      default:
        return hasDiff
          ? ` ${c.dim(theme.glyph.rule)}  ${c.gray(text)}`
          : railRow(c.gray(text), theme);
    }
  });
  if (hidden > 0) rows.push(elisionRow(hidden, theme));
  return rows;
}

function itemRows(items: readonly ToolGroupItem[], width: number, theme: Theme): string[] {
  const budget = Math.max(1, width - 4);
  const hasResults = items.some((item) => item.result !== undefined && item.result.length > 0);
  if (!hasResults) {
    return items.map((item) => railRow(theme.colors.gray(truncate(item.text, budget)), theme));
  }

  // Failure summaries align into one column so a mixed batch scans like a
  // table; long items yield to keep at least a short summary visible.
  const textColumn = Math.min(
    Math.max(...items.map((item) => visibleLength(item.text))),
    Math.max(8, budget - 9),
  );
  const resultBudget = Math.max(8, budget - textColumn - 1);
  return items.map((item) => {
    const text = truncate(item.text, textColumn);
    if (item.result === undefined || item.result.length === 0) {
      return railRow(theme.colors.gray(text), theme);
    }
    const padded = text + " ".repeat(Math.max(0, textColumn - visibleLength(text)));
    return railRow(
      `${theme.colors.gray(padded)} ${theme.colors.red(truncate(item.result, resultBudget))}`,
      theme,
    );
  });
}

function renderToolExpanded(block: DisplayBlock, width: number, theme: Theme): string[] {
  const rows: string[] = [];
  const push = (label: string, value: unknown, color: (text: string) => string) => {
    if (value === undefined) return;
    rows.push(`  ${theme.colors.dim(label)}`);
    for (const raw of formatValuePretty(value).split("\n")) {
      for (const line of wrapVisibleLine(raw, Math.max(1, width - 4))) {
        rows.push(`    ${color(line)}`);
      }
    }
  };
  push("input", block.toolInput, theme.colors.gray);
  if (block.status === "error" && block.result) {
    push("error", block.result, theme.colors.red);
  } else {
    push("output", block.toolOutput, theme.colors.gray);
  }
  return rows;
}

function resultLine(
  marker: string,
  text: string,
  width: number,
  theme: Theme,
  color: (text: string) => string,
): string {
  const budget = width - 4;
  return `  ${theme.colors.dim(marker)} ${color(truncate(text, budget))}`;
}

function errorDetailLine(text: string, width: number, theme: Theme): string {
  const budget = width - 5;
  return `   ${theme.colors.dim(theme.glyph.corner)} ${theme.colors.red(truncate(text, budget))}`;
}

function toolGlyph(
  status: ToolStatus,
  theme: Theme,
  context: RenderBlockContext,
): { icon: string; accent: (text: string) => string } {
  switch (status) {
    case "done":
      // The settled form of the running pulse (`▪` held steady), not a green
      // check: completed activity reads as a quiet one-line summary.
      return { icon: theme.colors.gray(theme.glyph.square), accent: theme.colors.gray };
    case "error":
      return { icon: theme.colors.red(theme.glyph.error), accent: theme.colors.red };
    case "denied":
      return { icon: theme.colors.yellow(theme.glyph.warning), accent: theme.colors.yellow };
    case "approval":
      return { icon: theme.colors.yellow(theme.glyph.question), accent: theme.colors.yellow };
    case "running":
    default:
      return { icon: theme.colors.yellow(context.activityPulse), accent: theme.colors.gray };
  }
}

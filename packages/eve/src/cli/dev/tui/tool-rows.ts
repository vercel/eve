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
  if ((block.depth ?? 0) === 0) {
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
  const rows = [renderToolHeader(name, block.subtitle ?? "", icon, width, theme)];

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
    rows.push(errorDetailLine(block.result, width, theme));
  } else if (block.status === "denied") {
    rows.push(resultLine(theme.glyph.arrow, "denied", width, theme, theme.colors.yellow));
  }

  return rows;
}

export function renderToolHeader(
  name: string,
  args: string,
  icon: string,
  width: number,
  theme: Theme,
): string {
  const headerWidth = Math.max(0, width - 3);
  const namePlain = clipVisible(name, headerWidth);
  let header = ` ${icon} ${boldLeadingWord(namePlain, theme)}`;
  const argsBudget = headerWidth - visibleLength(namePlain) - 2;
  if (args.length > 0 && argsBudget >= 6) {
    header += `  ${theme.colors.gray(truncate(args, argsBudget))}`;
  }
  return clipVisible(header, width);
}

function boldLeadingWord(text: string, theme: Theme): string {
  const split = text.indexOf(" ");
  if (split === -1) return theme.colors.bold(text);
  return `${theme.colors.bold(text.slice(0, split))}${theme.colors.dim(text.slice(split))}`;
}

function showToolDetail(block: DisplayBlock): boolean {
  if (block.detailLines === undefined || block.detailLines.length === 0) return false;
  const status = block.status ?? "running";
  if (status === "running" || status === "approval") return true;
  return block.keepDetailWhenDone === true;
}

export const maxVisibleToolGroupItems = 5;

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
  const hasDiff = visible.some((line) => line.kind === "added" || line.kind === "removed");
  const budget = Math.max(1, width - (hasDiff ? 5 : 4));

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

import type { PromptOptionNotice } from "#setup/cli/index.js";
import type { SelectNotice } from "#setup/prompter.js";

import type { Theme } from "./theme.js";
import { visibleLength, wrapVisibleLine } from "./terminal-text.js";

type SelectLayout = "plain" | "stacked" | "task-list";

export function toneGlyph(tone: SelectNotice["tone"], theme: Theme): string {
  const c = theme.colors;
  switch (tone) {
    case "success":
      return c.green(theme.glyph.success);
    case "warning":
      return c.yellow(theme.glyph.warning);
    case "error":
      return c.red(theme.glyph.error);
    case "info":
      return c.dim(theme.glyph.dot);
  }
}

function noticeBody(notice: SelectNotice, layout: SelectLayout, theme: Theme): string {
  if (notice.tone === "info") return theme.colors.dim(notice.text);
  if (notice.tone === "success" && layout === "task-list") {
    return theme.colors.bold(notice.text);
  }
  return notice.text;
}

export function appendOptionNoticeRows(
  rows: string[],
  notice: PromptOptionNotice,
  theme: Theme,
  width: number,
): void {
  const indent = " ".repeat(4);
  const glyph = toneGlyph(notice.tone, theme);
  const firstPrefix = `${glyph} `;
  const hangingIndent = " ".repeat(visibleLength(glyph) + 1);
  const textWidth = Math.max(1, width - indent.length - visibleLength(firstPrefix));
  for (const [lineIndex, text] of notice.lines.entries()) {
    const wrapped = wrapVisibleLine(text, textWidth);
    for (const [wrapIndex, line] of wrapped.entries()) {
      const prefix = lineIndex === 0 && wrapIndex === 0 ? firstPrefix : hangingIndent;
      rows.push(`${indent}${prefix}${theme.colors.dim(line)}`);
    }
  }
}

export function appendSelectNotices(
  rows: string[],
  notices: readonly SelectNotice[] | undefined,
  layout: SelectLayout,
  theme: Theme,
  width: number,
): void {
  if (notices === undefined || notices.length === 0) return;
  rows.push("");
  for (const notice of notices) {
    const glyph = toneGlyph(notice.tone, theme);
    const hangingIndent = " ".repeat(visibleLength(glyph) + 1);
    const textWidth = Math.max(1, width - 2 - visibleLength(glyph) - 1);
    const wrapped = wrapVisibleLine(notice.text, textWidth);
    for (const [index, line] of wrapped.entries()) {
      const body = noticeBody({ ...notice, text: line }, layout, theme);
      rows.push(index === 0 ? `  ${glyph} ${body}` : `  ${hangingIndent}${body}`);
    }
  }
}

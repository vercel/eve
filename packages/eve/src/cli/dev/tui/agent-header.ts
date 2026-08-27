/** Builds the startup card the dev TUI commits before the first prompt. */

import type { AgentInfoResult } from "#client/index.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { clipVisible, visibleLength } from "#cli/ui/terminal-text.js";
import { isPromptControlCommand } from "./prompt-commands.js";
import type { Theme } from "./theme.js";

export interface AgentHeaderInput {
  /** Resolved display name used when agent inspection is unavailable. */
  name?: string;
  /** Agent inspection payload, or `undefined` when it could not be fetched. */
  info?: AgentInfoResult;
  theme: Theme;
  /** Available terminal width. */
  width: number;
  /** Message-of-the-day line rendered below the startup card, when present. */
  tip?: string;
}

/**
 * The header's message-of-the-day pool. All entries reference local-only
 * slash commands, so callers only attach a tip to local `eve dev` sessions.
 */
export const AGENT_HEADER_TIPS: readonly string[] = [
  "Use the /add command to install an integration.",
  "Use the /deploy command to deploy your agent.",
  "Use the /help command to see every command.",
];

/** Picks one tip; `random` is a test seam over Math.random. */
export function pickAgentHeaderTip(random: () => number = Math.random): string {
  const index = Math.min(
    AGENT_HEADER_TIPS.length - 1,
    Math.floor(random() * AGENT_HEADER_TIPS.length),
  );
  return AGENT_HEADER_TIPS[index]!;
}

/** Returns the styled rows of the startup card and optional tip. */
export function buildAgentHeader(input: AgentHeaderInput): string[] {
  const { theme, info, width } = input;
  const c = theme.colors;
  const version = resolveInstalledPackageInfo().version;
  // Leave the terminal's final column untouched so terminals that wrap on a
  // write there do not add an untracked row beneath the live region.
  const cardWidth = Math.min(68, Math.max(0, width - 1));

  const brand = `${c.dim("☰")}${c.bold("eve")} ${c.dim(`(v${version})`)}`;
  if (cardWidth < 4) return [clipVisible(brand, width)];

  const horizontal = theme.unicode ? "─" : "-";
  const vertical = theme.unicode ? "│" : "|";
  const topLeft = theme.unicode ? "╭" : "+";
  const topRight = theme.unicode ? "╮" : "+";
  const bottomLeft = theme.unicode ? "╰" : "+";
  const bottomRight = theme.unicode ? "╯" : "+";
  const innerWidth = cardWidth - 2;
  const border = horizontal.repeat(innerWidth);
  const row = (text = "", ambiguousWidth = 0): string => {
    const available = Math.max(0, innerWidth - 2);
    const body = clipVisible(text, available);
    const padding = Math.max(0, available - visibleLength(body) - ambiguousWidth);
    return `${c.dim(vertical)} ${body}${" ".repeat(padding)} ${c.dim(vertical)}`;
  };

  const agentName = info?.agent.name ?? input.name;
  const title =
    agentName === undefined ? brand : spreadRow(brand, c.bold(agentName), innerWidth - 2, 1);
  const lines = [c.dim(`${topLeft}${border}${topRight}`)];
  // U+2630 is East Asian Ambiguous and renders as two cells in some
  // terminals, so reserve its second cell explicitly inside the card.
  lines.push(row(title, 1));
  lines.push(row());
  if (input.tip !== undefined) {
    lines.push(row(`${c.bold("Tip:")} ${renderTip(input.tip, innerWidth - 7, theme)}`));
  }
  lines.push(c.dim(`${bottomLeft}${border}${bottomRight}`));

  if (info && (info.diagnostics.discoveryErrors > 0 || info.diagnostics.discoveryWarnings > 0)) {
    const parts: string[] = [];
    if (info.diagnostics.discoveryErrors > 0) {
      parts.push(
        c.red(
          `${info.diagnostics.discoveryErrors} error${plural(info.diagnostics.discoveryErrors)}`,
        ),
      );
    }
    if (info.diagnostics.discoveryWarnings > 0) {
      parts.push(
        c.yellow(
          `${info.diagnostics.discoveryWarnings} warning${plural(
            info.diagnostics.discoveryWarnings,
          )}`,
        ),
      );
    }
    lines.push("", `  ${c.dim(theme.glyph.warning)} ${parts.join(c.dim(" · "))}`);
  }

  return lines;
}

function spreadRow(left: string, right: string, width: number, ambiguousWidth: number): string {
  const available = Math.max(1, width - ambiguousWidth);
  const clippedLeft = clipVisible(left, Math.max(1, available - visibleLength(right) - 1));
  const clippedRight = clipVisible(right, Math.max(1, available - visibleLength(clippedLeft) - 1));
  const gap = Math.max(1, available - visibleLength(clippedLeft) - visibleLength(clippedRight));
  return `${clippedLeft}${" ".repeat(gap)}${clippedRight}`;
}

function renderTip(tip: string, width: number, theme: Theme): string {
  return clipVisible(
    tip
      .split(/(\/[a-z:-]+)/u)
      .map((part) =>
        isPromptControlCommand(part) ? theme.colors.blue(part) : theme.colors.dim(part),
      )
      .join(""),
    width,
  );
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

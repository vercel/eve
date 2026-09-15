/** Builds the startup card the dev TUI commits before the first prompt. */

import type { AgentInfoResult } from "#client/index.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { clipVisible } from "#cli/ui/terminal-text.js";
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
  "/add to extend your agent · /help for commands",
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
  const available = Math.max(0, width - 1);
  const agentName = info?.agent.name ?? input.name;
  const title = `${c.bold("eve")} ${c.dim(`v${version}`)}${agentName ? `  ${agentName}` : ""}`;
  const lines = [clipVisible(title, available)];
  if (input.tip) lines.push(renderTip(input.tip, available, theme));

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

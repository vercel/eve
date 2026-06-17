/**
 * Builds the startup header the dev TUI commits to scrollback before the
 * first prompt: one `eve <agent name>` brand line, a discovery-diagnostics
 * line when the compiler reported problems, and a rotating tip for local
 * sessions. The resolved model is not repeated here — it lives on the
 * persistent status line at the bottom.
 */

import type { AgentInfoResult } from "#client/index.js";
import { EVE_BETA_TERMS_URL } from "#cli/banner.js";
import type { Theme } from "./theme.js";
import { truncate } from "./tool-format.js";

export interface AgentHeaderInput {
  /** Resolved display name (e.g. "weather-agent"). */
  name: string;
  /** Agent inspection payload, or `undefined` when it could not be fetched. */
  info?: AgentInfoResult;
  theme: Theme;
  /** Available terminal width. */
  width: number;
  /** Message-of-the-day line rendered under the brand line, when present. */
  tip?: string;
}

/**
 * The header's message-of-the-day pool. All entries reference local-only
 * slash commands, so callers only attach a tip to local `eve dev` sessions.
 */
export const AGENT_HEADER_TIPS: readonly string[] = [
  "Use /channels to add more ways to reach your agent.",
  "Use /deploy to see your agent go live.",
  "Type /help to see every command.",
];

/** Picks one tip; `random` is a test seam over Math.random. */
export function pickAgentHeaderTip(random: () => number = Math.random): string {
  const index = Math.min(
    AGENT_HEADER_TIPS.length - 1,
    Math.floor(random() * AGENT_HEADER_TIPS.length),
  );
  return AGENT_HEADER_TIPS[index]!;
}

/**
 * Returns the styled rows of the startup header (no trailing blank line is
 * added by callers other than the one separating it from the transcript).
 */
export function buildAgentHeader(input: AgentHeaderInput): string[] {
  const { theme, info, name, width } = input;
  const c = theme.colors;

  const lines: string[] = [];
  const brand = c.bold("eve");
  lines.push(` ${brand} ${c.dim(truncate(name, Math.max(8, width - 8)))}`);
  lines.push(
    ` ${c.dim(
      truncate(`eve is currently in preview: ${EVE_BETA_TERMS_URL}`, Math.max(8, width - 2)),
    )}`,
  );

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
    lines.push(` ${c.dim(theme.glyph.warning)} ${parts.join(c.dim(" · "))}`);
  }

  if (input.tip !== undefined) {
    lines.push(` ${c.dim(truncate(input.tip, Math.max(8, width - 2)))}`);
  }

  return lines;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

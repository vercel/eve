/** Builds the startup card the dev TUI commits before the first prompt. */

import type { AgentInfoResult } from "#client/index.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { clipVisible } from "#cli/ui/terminal-text.js";
import type { Theme } from "./theme.js";

export interface AgentHeaderInput {
  /** Resolved display name used when agent inspection is unavailable. */
  name?: string;
  /** Agent inspection payload, or `undefined` when it could not be fetched. */
  info?: AgentInfoResult;
  theme: Theme;
  /** Available terminal width. */
  width: number;
}

/** Returns the styled rows of the startup card and optional tip. */
export function buildAgentHeader(input: AgentHeaderInput): string[] {
  const { theme, info, width } = input;
  const c = theme.colors;
  const version = resolveInstalledPackageInfo().version;
  const available = Math.max(0, width - 1);
  const agentName = info?.agent.name ?? input.name;
  const metadata = [
    ...(agentName === undefined ? [] : [c.dim(agentName)]),
    c.dim("Run /help for commands"),
  ].join(c.dim(" · "));
  const title = c.bold("☰eve") + c.dim(` v${version} · `) + metadata;
  const lines = [clipVisible(title, available)];

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

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

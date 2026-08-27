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

const MAX_TOOL_GROUPS = 4;

const EVE_LOGO = [
  "⣿⣿⣿⣿⣿⣿⣿⣿⣿    ⠏⣿⣿⣿⣿⣿⣿⣿⣿⣿",
  "            ⠇⣿⠏",
  "⣿⣿⣿⣿⣿⣿⠇    ⠇⣿⠏   ⠇⣿⣿⣿⣿⣿",
  "          ⠃⣿⠏",
  "⣿⣿⣿⣿⣿⣿⠏  ⠃⣿⠏   ⠇⣿⣿⣿⣿⣿⣿⣿",
] as const;

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
  const logoWidth = Math.max(...EVE_LOGO.map((line) => visibleLength(line)));
  if (theme.unicode && innerWidth - 2 >= logoWidth) {
    lines.push(
      ...EVE_LOGO.map((line) => row(centerLogoLine(line, logoWidth, innerWidth - 2, theme))),
      row(),
    );
  }

  const detail = (label: string, value: string): string =>
    row(`${c.dim(label.padEnd(14))}${value}`);
  const model = formatHeaderModel(info?.agent.model, theme);
  if (model !== undefined) lines.push(detail("model", model));
  if (info !== undefined) {
    lines.push(detail("instructions", formatInstructions(info, innerWidth - 18)));
    lines.push(row());
    const toolGroups = groupTools(info);
    if (toolGroups.length === 0) {
      lines.push(detail("tools", "none"));
    } else {
      lines.push(detail("tools", ""));
      for (const group of toolGroups.slice(0, MAX_TOOL_GROUPS)) {
        lines.push(detail(`  ${group.label}`, fitNames(group.names, innerWidth - 18)));
      }
      const omittedGroups = toolGroups.length - MAX_TOOL_GROUPS;
      if (omittedGroups > 0) {
        lines.push(detail(`  +${omittedGroups} ${pluralize(omittedGroups, "group")}`, ""));
      }
    }
    lines.push(detail("skills", fitNames(skillNames(info), innerWidth - 18)));
    lines.push(detail("subagents", fitNames(subagentNames(info), innerWidth - 18)));
    lines.push(
      detail(
        "schedules",
        fitNames(
          info.schedules.map((schedule) => schedule.name),
          innerWidth - 18,
        ),
      ),
    );
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

  if (input.tip !== undefined) {
    lines.push("", `  ${c.bold("Tip:")} ${renderTip(input.tip, Math.max(8, width - 7), theme)}`);
  }

  return lines;
}

function centerLogoLine(text: string, logoWidth: number, width: number, theme: Theme): string {
  const padding = Math.max(0, Math.floor((width - logoWidth) / 2));
  return `${" ".repeat(padding)}${theme.colors.cyan(text)}`;
}

function spreadRow(left: string, right: string, width: number, ambiguousWidth: number): string {
  const available = Math.max(1, width - ambiguousWidth);
  const clippedLeft = clipVisible(left, Math.max(1, available - visibleLength(right) - 1));
  const clippedRight = clipVisible(right, Math.max(1, available - visibleLength(clippedLeft) - 1));
  const gap = Math.max(1, available - visibleLength(clippedLeft) - visibleLength(clippedRight));
  return `${clippedLeft}${" ".repeat(gap)}${clippedRight}`;
}

function groupTools(info: AgentInfoResult): Array<{ label: string; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const tool of info.tools.static) {
    const label =
      tool.owner.kind === "application"
        ? "agent"
        : tool.owner.kind === "framework"
          ? "eve"
          : tool.owner.namespace;
    const names = groups.get(label) ?? [];
    names.push(tool.name);
    groups.set(label, names);
  }
  if (info.tools.dynamic.length > 0) {
    groups.set(
      "dynamic",
      info.tools.dynamic.map((resolver) => resolver.slug),
    );
  }
  const priority = (label: string): number => {
    if (label === "agent") return 0;
    if (label === "dynamic") return 2;
    if (label === "eve") return 3;
    return 1;
  };
  return [...groups]
    .map(([label, names]) => ({ label, names: names.sort() }))
    .sort((a, b) => priority(a.label) - priority(b.label) || a.label.localeCompare(b.label));
}

function skillNames(info: AgentInfoResult): string[] {
  return [
    ...info.skills.static.map((skill) => skill.name),
    ...info.skills.dynamic.map((resolver) => `${resolver.slug} (dynamic)`),
  ].sort();
}

function subagentNames(info: AgentInfoResult): string[] {
  return [...info.subagents.local, ...info.remoteAgents.entries]
    .map((subagent) => subagent.name)
    .sort();
}

function formatInstructions(info: AgentInfoResult, width: number): string {
  const names = [
    ...info.instructions.static.map(
      (instructions) => `${instructions.logicalPath} (${instructions.role})`,
    ),
    ...info.instructions.dynamic.map((resolver) => `${resolver.slug} (dynamic)`),
  ];
  return fitNames(names, width);
}

function fitNames(names: readonly string[], width: number): string {
  if (names.length === 0) return "none";
  for (let count = names.length; count > 0; count -= 1) {
    const hidden = names.length - count;
    const value = `${names.slice(0, count).join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;
    if (visibleLength(value) <= width) return value;
  }
  return clipVisible(names[0]!, width);
}

function formatHeaderModel(
  model: AgentInfoResult["agent"]["model"] | undefined,
  theme: Theme,
): string | undefined {
  if (model?.id === undefined) return undefined;
  const endpoint = model.endpoint;
  if (endpoint === undefined) return model.id;

  const via = theme.colors.dim("via ");
  switch (endpoint.kind) {
    case "external":
      return `${model.id} ${via}${endpoint.provider}`;
    case "chatgpt":
      return `${model.id} ${via}chatgpt-sub`;
    case "gateway":
      return endpoint.connected
        ? `${model.id} ${via}ai-gateway(${endpoint.credential})`
        : `${model.id} ${via}ai-gateway(not connected)`;
  }
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

function pluralize(count: number, noun: string): string {
  return `${noun}${plural(count)}`;
}

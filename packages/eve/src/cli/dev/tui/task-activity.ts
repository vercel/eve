/**
 * The tasks a turn has working: agents and tools that keep running while the
 * turn goes on. The transcript only ever grows at its end, so a task writes
 * one line when it starts and one when it ends; what it is doing in between
 * lives here and renders in the fixed task panel above the prompt, the one
 * region that redraws in place.
 */

import type { Block } from "./blocks.js";
import type { Theme } from "./theme.js";
import { formatTurnDuration } from "./stream-format.js";
import { TOOL_COLUMN_LEAD } from "./rail.js";
import { truncate } from "./tool-format.js";
import { clipVisible, visibleLength } from "#cli/ui/terminal-text.js";

export type TaskKind = "agent" | "tool";

export interface TaskEntry {
  readonly callId: string;
  readonly kind: TaskKind;
  /** Display name, unique among working tasks. */
  readonly name: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly label: string | undefined;
  readonly startedAtMs: number;
  /** An agent's latest words or thinking, one line. */
  step?: string;
  /** An agent's own tool calls, newest last, for its activity and summary. */
  readonly childTools: Map<string, Block>;
}

/** The panel shows this many tasks; the rest collapse into one counted row. */
const maxPanelRows = 4;

export class TaskActivity {
  readonly #entries = new Map<string, TaskEntry>();

  start(input: {
    readonly callId: string;
    readonly kind: TaskKind;
    readonly baseName: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly label: string | undefined;
    readonly nowMs: number;
  }): TaskEntry {
    const entry: TaskEntry = {
      callId: input.callId,
      kind: input.kind,
      name: this.#uniqueName(input.baseName),
      toolName: input.toolName,
      input: input.input,
      label: input.label,
      startedAtMs: input.nowMs,
      childTools: new Map(),
    };
    this.#entries.set(input.callId, entry);
    return entry;
  }

  get(callId: string): TaskEntry | undefined {
    return this.#entries.get(callId);
  }

  /** Removes and returns a task that ended. */
  finish(callId: string): TaskEntry | undefined {
    const entry = this.#entries.get(callId);
    this.#entries.delete(callId);
    return entry;
  }

  working(): readonly TaskEntry[] {
    return [...this.#entries.values()];
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Parallel calls to one agent read `researcher`, `researcher #2`, …; a name is never renamed. */
  #uniqueName(baseName: string): string {
    const taken = new Set([...this.#entries.values()].map((entry) => entry.name));
    if (!taken.has(baseName)) return baseName;
    for (let ordinal = 2; ; ordinal += 1) {
      const candidate = `${baseName} #${String(ordinal)}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}

/** Joins the working tasks' names for the turn bar: `Waiting for researcher and reviewer`. */
export function waitingLabel(entries: readonly TaskEntry[]): string {
  const names = entries.map((entry) => entry.name);
  if (names.length === 1) return `Waiting for ${names[0]!}`;
  if (names.length === 2) return `Waiting for ${names[0]!} and ${names[1]!}`;
  return `Waiting for ${String(names.length)} tasks`;
}

/** What a working task is doing right now, in one short line. */
function currentActivity(entry: TaskEntry): { text: string; attention: boolean } {
  const tools = [...entry.childTools.values()];
  const awaiting = tools.findLast((tool) => tool.status === "approval");
  if (awaiting !== undefined) {
    return { text: `Needs your approval: ${awaiting.title ?? "tool"}`, attention: true };
  }
  const running = tools.findLast((tool) => tool.status === "running");
  if (running !== undefined) return { text: running.title ?? "Working", attention: false };
  if (entry.step !== undefined) return { text: entry.step, attention: false };
  return { text: entry.kind === "agent" ? "Starting" : "Working", attention: false };
}

/**
 * One row per working task — mark, name, current activity, elapsed time —
 * capped so a wide fan-out cannot push the prompt off screen.
 */
export function renderTaskPanelRows(
  entries: readonly TaskEntry[],
  options: {
    readonly width: number;
    readonly theme: Theme;
    readonly nowMs: number;
    readonly pulse: string;
  },
): string[] {
  const { width, theme, nowMs } = options;
  const c = theme.colors;
  const shown = entries.length > maxPanelRows ? entries.slice(0, maxPanelRows - 1) : entries;
  const nameWidth = Math.min(24, Math.max(...shown.map((entry) => visibleLength(entry.name)), 0));
  const rows = shown.map((entry) => {
    const mark =
      options.pulse.trim().length > 0
        ? c.orange(theme.glyph.subagent)
        : c.dim(theme.glyph.subagent);
    const name = truncate(entry.name, nameWidth);
    const padded = name + " ".repeat(Math.max(0, nameWidth - visibleLength(name)));
    const elapsed = formatTurnDuration(nowMs - entry.startedAtMs);
    const lead = `${TOOL_COLUMN_LEAD}${mark} ${padded}  `;
    const budget = width - visibleLength(lead) - elapsed.length - 2;
    const activity = currentActivity(entry);
    const text = budget >= 4 ? truncate(activity.text, budget) : "";
    const color = activity.attention ? c.yellow : c.dim;
    const gap = Math.max(1, width - visibleLength(lead) - visibleLength(text) - elapsed.length);
    return clipVisible(`${lead}${color(text)}${" ".repeat(gap)}${c.dim(elapsed)}`, width);
  });
  const hidden = entries.length - shown.length;
  if (hidden > 0) {
    rows.push(
      clipVisible(
        `${TOOL_COLUMN_LEAD}${c.dim(`${theme.glyph.ellipsis} ${String(hidden)} more working`)}`,
        width,
      ),
    );
  }
  return rows;
}

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
import { renderTransientDrawer } from "./flow-drawer.js";
import { truncate } from "./tool-format.js";
import { isSelfModificationAgent } from "./tool-presentation.js";
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
  readonly purpose?: string;
  readonly children?: readonly TaskEntry[];
  /** An agent's latest words or thinking, one line. */
  step?: string;
  /** Settled, waiting only for the agent's own last events. */
  finishing?: boolean;
  /** An agent's own tool calls, newest last, for its activity and summary. */
  readonly childTools: Map<string, Block>;
}

/** Includes the heading and overflow summary, regardless of nesting. */
const maxPanelRows = 11;

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
  if (entries.length === 1 && isSelfModificationAgent(entries[0]!.toolName)) {
    return "Modifying your agent";
  }
  const names = entries.map(taskLabel);
  if (names.length === 1) return `Waiting for ${names[0]!}`;
  if (names.length === 2) return `Waiting for ${names[0]!} and ${names[1]!}`;
  return `Waiting for ${String(names.length)} tasks`;
}

/** Names the connections a parked session waits on: `Waiting for sign-in to Linear`. */
export function signInLabel(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length === 1) return `Waiting for sign-in to ${unique[0]!}`;
  if (unique.length === 2) return `Waiting for sign-in to ${unique[0]!} and ${unique[1]!}`;
  return `Waiting for ${String(unique.length)} sign-ins`;
}

/** What a working task is doing right now, in one short line. */
function currentActivity(entry: TaskEntry): { text: string; attention: boolean } {
  if (entry.finishing === true) return { text: "Finishing", attention: false };
  const tools = [...entry.childTools.values()];
  const awaiting = tools.findLast((tool) => tool.status === "approval");
  if (awaiting !== undefined) {
    return { text: `Needs your approval: ${awaiting.title ?? "tool"}`, attention: true };
  }
  const running = tools.findLast((tool) => tool.status === "running");
  if (running !== undefined) return { text: running.title ?? "Working", attention: false };
  if (entry.step !== undefined) return { text: entry.step, attention: false };
  return { text: entry.kind === "agent" ? "Starting" : "Running", attention: false };
}

/** Stable ownership order, with only one visible level of indentation. */
function taskLabel(entry: TaskEntry): string {
  if (entry.kind !== "agent") return entry.name;
  const name = entry.name.replace(/__agent(?= #\d+$|$)/u, "");
  return name === "subagent" ? name : `subagent(${name})`;
}

function panelEntries(entries: readonly TaskEntry[]): Array<{ entry: TaskEntry; path: string[] }> {
  const rows: Array<{ entry: TaskEntry; path: string[] }> = [];
  const visit = (tasks: readonly TaskEntry[], path: string[], depth: number): void => {
    if (depth > 8 || rows.length >= 128) return;
    for (const entry of tasks) {
      if (rows.length >= 128) break;
      rows.push({ entry, path });
      visit(entry.children ?? [], [...path, taskLabel(entry)], depth + 1);
    }
  };
  visit(entries, [], 0);
  return rows;
}

export function renderTaskPanelRows(
  entries: readonly TaskEntry[],
  options: {
    readonly width: number;
    readonly theme: Theme;
    readonly nowMs: number;
    readonly activity?: string;
    readonly turnElapsedMs?: number;
    readonly maxRows?: number;
  },
): string[] {
  if (entries.length === 0) return [];
  const { width, theme, nowMs } = options;
  const c = theme.colors;
  const tasks = panelEntries(entries);
  const budget = Math.max(2, Math.min(maxPanelRows, options.maxRows ?? maxPanelRows));
  const padded = budget >= 5;
  const contentBudget = Math.max(0, budget - (padded ? 4 : 2));
  const overflow = tasks.length * 2 > contentBudget;
  const capacity = Math.max(0, Math.floor((contentBudget - (overflow ? 1 : 0)) / 2));
  // Approval requests must not disappear behind a busy branch's overflow summary.
  const attention = tasks.filter(({ entry }) => currentActivity(entry).attention);
  const selected = new Set(
    [...attention, ...tasks.filter((task) => !attention.includes(task))].slice(0, capacity),
  );
  const shown = tasks.filter((task) => selected.has(task));
  const rows: string[] = [];
  for (const { entry, path } of shown) {
    const nested = path.length > 0;
    const lead = `  ${nested ? `${theme.glyph.corner} ` : ""}`;
    const parentShown = shown.some((task) => taskLabel(task.entry) === path.at(-1));
    const owners = parentShown ? path.slice(1) : path;
    const ownership =
      owners.length > 0 ? `${owners.join(` ${theme.glyph.arrow} `)} ${theme.glyph.arrow} ` : "";
    rows.push(clipVisible(`${lead}${c.bold(`${ownership}${taskLabel(entry)}`)}`, width));
    const activity = currentActivity(entry);
    const elapsed = formatTurnDuration(nowMs - entry.startedAtMs);
    const detailLead = `    ${nested ? "  " : ""}${theme.glyph.elbow} `;
    const suffix = ` ${theme.glyph.dot} ${elapsed}`;
    const text = truncate(
      activity.text,
      Math.max(0, width - visibleLength(detailLead) - suffix.length),
    );
    const color = activity.attention ? c.yellow : c.dim;
    rows.push(clipVisible(`${detailLead}${color(text)}${c.dim(suffix)}`, width));
  }
  const hidden = tasks.length - shown.length;
  if (hidden > 0 && rows.length < contentBudget) {
    rows.push(clipVisible(`  ${c.dim(`${theme.glyph.ellipsis} ${hidden} more working`)}`, width));
  }
  return renderTransientDrawer(
    rows,
    [],
    theme,
    width,
    `${options.activity ?? "Working"} ${theme.glyph.dot} ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}${options.turnElapsedMs === undefined ? "" : ` ${theme.glyph.dot} ${formatTurnDuration(options.turnElapsedMs)}`}`,
    !padded,
    "left",
  ).rows;
}

/**
 * Condensed display form of the dev server's rebuild lifecycle. The renderer
 * cycles these strings through one in-place status block instead of stacking
 * the watcher's full log lines: changed paths shrink to their last two
 * components and each lifecycle phase renders as one short clause.
 */

import type { WatcherChangeEvent } from "#internal/nitro/host/dev-watcher-log.js";

export type DevRebuildPhase = "rebuilding" | "rebuilt" | "reloading";

const MAX_SUMMARY_PATHS = 3;

/**
 * Summarizes one batch of watcher change events as `<paths> <verb>` — e.g.
 * `tui/setup-panel.ts changed`. Paths shrink to their last two components,
 * duplicates collapse, and everything past {@link MAX_SUMMARY_PATHS} folds
 * into a `+N more` (combined with `more`, the count the watcher already
 * truncated from its own log line).
 */
export function summarizeChangedFiles(events: readonly WatcherChangeEvent[], more: number): string {
  const paths = [...new Set(events.map((event) => lastPathComponents(event.path)))];
  const shown = paths.slice(0, MAX_SUMMARY_PATHS);
  const hidden = paths.length - shown.length + more;
  const suffix = hidden > 0 ? ` +${hidden} more` : "";
  return `${shown.join(", ")}${suffix} ${changeVerb(events)}`;
}

/**
 * Renders the status line body for one lifecycle phase, e.g.
 * `tui/setup-panel.ts changed · rebuilding…`.
 */
export function formatDevRebuildStatus(summary: string, phase: DevRebuildPhase): string {
  switch (phase) {
    case "rebuilding":
      return `${summary} · rebuilding…`;
    case "rebuilt":
      return `${summary} · rebuilt`;
    case "reloading":
      return `${summary} · reloading server…`;
  }
}

function changeVerb(events: readonly WatcherChangeEvent[]): string {
  const kinds = [...new Set(events.map((event) => event.event))];
  if (kinds.every((kind) => kind === "add" || kind === "addDir")) return "added";
  if (kinds.every((kind) => kind === "unlink" || kind === "unlinkDir")) return "removed";
  return "changed";
}

function lastPathComponents(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.slice(-2).join("/");
}

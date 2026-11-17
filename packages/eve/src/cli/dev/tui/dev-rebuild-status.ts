import type { WatcherChangeEvent } from "#internal/nitro/host/dev-watcher-log.js";

type DevRebuildPhase = "rebuilding" | "rebuilt" | "reloading";

const MAX_SUMMARY_PATHS = 3;

export function summarizeChangedFiles(events: readonly WatcherChangeEvent[], more: number): string {
  const paths = [...new Set(events.map((event) => lastPathComponents(event.path)))];
  const shown = paths.slice(0, MAX_SUMMARY_PATHS);
  const hidden = paths.length - shown.length + more;
  const suffix = hidden > 0 ? ` +${hidden} more` : "";
  return `${shown.join(", ")}${suffix} ${changeVerb(events)}`;
}

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

import { isAbsolute, relative, sep } from "node:path";

export interface WatcherChangeEvent {
  readonly event: string;
  readonly path: string;
}

export type DevRebuildLogUpdate =
  | { kind: "rebuilding"; events: WatcherChangeEvent[]; more: number }
  | { kind: "failed"; message: string }
  | { kind: "rebuilt" }
  | { kind: "reloading" };

const MAX_LOGGED_CHANGE_EVENTS = 6;

export const AUTHORED_ARTIFACTS_UPDATED_LOG_LINE = "[eve:dev] authored artifacts updated.";

export const STRUCTURAL_RELOAD_LOG_LINE =
  "[eve:dev] structural change detected, reloading Nitro worker...";

export function formatChangeDetectedLogLine(
  appRoot: string,
  events: readonly WatcherChangeEvent[],
): string {
  return `[eve:dev] change detected (${formatChangeEventList(appRoot, events)}), rebuilding authored artifacts...`;
}

const CHANGE_DETECTED_PATTERN =
  /^\[eve:dev\] change detected \(\d+ events?: (.+)\), rebuilding authored artifacts\.\.\.$/u;
const MORE_EVENTS_PATTERN = /^\+(\d+) more$/u;
const REBUILD_FAILED_PATTERN = /^\[eve:dev\] rebuild (?:failed|queue error): (.+)$/u;

export function parseDevRebuildLogLine(line: string): DevRebuildLogUpdate | undefined {
  if (line === AUTHORED_ARTIFACTS_UPDATED_LOG_LINE) return { kind: "rebuilt" };
  if (line === STRUCTURAL_RELOAD_LOG_LINE) return { kind: "reloading" };

  const failedMatch = REBUILD_FAILED_PATTERN.exec(line);
  if (failedMatch !== null) return { kind: "failed", message: failedMatch[1]! };

  const match = CHANGE_DETECTED_PATTERN.exec(line);
  if (match === null) return undefined;

  const events: WatcherChangeEvent[] = [];
  let more = 0;
  for (const item of match[1]!.split(", ")) {
    const moreMatch = MORE_EVENTS_PATTERN.exec(item);
    if (moreMatch !== null) {
      more += Number(moreMatch[1]);
      continue;
    }
    const separator = item.indexOf(" ");
    if (separator === -1) return undefined;
    events.push({ event: item.slice(0, separator), path: item.slice(separator + 1) });
  }

  if (events.length === 0) return undefined;
  return { kind: "rebuilding", events, more };
}

function formatChangeEventList(appRoot: string, events: readonly WatcherChangeEvent[]): string {
  const prefix = `${events.length} event${events.length === 1 ? "" : "s"}`;
  const displayed = events.slice(0, MAX_LOGGED_CHANGE_EVENTS).map((event) => {
    return `${event.event} ${formatChangeEventPath(appRoot, event.path)}`;
  });
  const remaining = events.length - displayed.length;

  if (remaining > 0) {
    displayed.push(`+${remaining} more`);
  }

  return `${prefix}: ${displayed.join(", ")}`;
}

function formatChangeEventPath(appRoot: string, changedPath: string): string {
  const relativePath = relative(appRoot, changedPath);
  const isOutsideApp =
    relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
  const displayPath = relativePath.length > 0 && !isOutsideApp ? relativePath : changedPath;

  return displayPath.replaceAll("\\", "/");
}

export const browserActivityKinds = [
  "model",
  "playwright",
  "semantic",
  "visual",
  "web",
  "vault",
  "setup",
  "waiting",
  "other",
] as const;

export type BrowserActivityKind = (typeof browserActivityKinds)[number];
export type BrowserActivityDurations = Partial<
  Record<BrowserActivityKind, number>
>;

const toolActivityKind = new Map<string, BrowserActivityKind>([
  ["browser_act", "semantic"],
  ["browser_find", "semantic"],
  ["browser_snapshot", "semantic"],
  ["browser_text", "semantic"],
  ["browser_wait_for", "semantic"],
  ["capture_browser_image", "visual"],
  ["computer_action", "visual"],
  ["fill_from_vault", "vault"],
  ["list_vault", "vault"],
  ["load_skill", "setup"],
  ["manage_browsers", "setup"],
  ["playwright_execute", "playwright"],
  ["web_fetch", "web"],
  ["web_search", "web"],
]);

export function browserActivityKindForTool(name: string): BrowserActivityKind {
  return toolActivityKind.get(name) ?? "other";
}

export function browserTraceActivityDurations(
  events: readonly {
    readonly at: string;
    readonly label: string;
    readonly type: string;
  }[],
  now = Date.now()
) {
  return sumBrowserActivityDurations(
    events.flatMap((event) => {
      const kind = browserTraceActivityKind(event);
      return kind ? [{ at: Date.parse(event.at), kind }] : [];
    }),
    now
  );
}

export function sumBrowserActivityDurations(
  points: readonly {
    readonly at: number;
    readonly kind: BrowserActivityKind;
  }[],
  now = Date.now()
) {
  const durations: BrowserActivityDurations = {};
  let current: (typeof points)[number] | null = null;

  for (const point of points) {
    if (!Number.isFinite(point.at)) continue;
    if (current) {
      addDuration(durations, current.kind, Math.max(0, point.at - current.at));
    }
    current = point;
  }
  if (current) {
    addDuration(durations, current.kind, Math.max(0, now - current.at));
  }
  return durations;
}

/**
 * Classifies a stored trace row by the session event that produced it. Rows
 * recorded before eve 1.0 keep their v26 event types, so both are recognized.
 */
function browserTraceActivityKind(event: {
  readonly label: string;
  readonly type: string;
}): BrowserActivityKind | null {
  if (event.type === "call.requested" || event.type === "actions.requested") {
    return event.label === "Load skill"
      ? "setup"
      : browserActivityKindForTool(event.label);
  }
  if (
    event.type === "interaction.opened" ||
    event.type === "input.requested" ||
    event.type === "authorization.required"
  ) {
    return "waiting";
  }
  if (
    event.type === "delivery.consumed" ||
    event.type === "content.completed" ||
    event.type === "call.settled" ||
    event.type === "interaction.settled" ||
    event.type === "message.received" ||
    event.type === "message.completed" ||
    event.type === "action.result" ||
    event.type === "input.resolved" ||
    event.type === "authorization.completed" ||
    event.type === "result.completed"
  ) {
    return "model";
  }
  return null;
}

function addDuration(
  durations: BrowserActivityDurations,
  kind: BrowserActivityKind,
  durationMs: number
) {
  if (durationMs === 0) return;
  durations[kind] = Math.round((durations[kind] ?? 0) + durationMs);
}

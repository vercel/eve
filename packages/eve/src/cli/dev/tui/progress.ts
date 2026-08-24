import type {
  ProgressActionV1,
  ProgressBlockerV1,
  ProgressSnapshotV1,
  ProgressWorkV1,
} from "#protocol/progress.js";

const TUI_ACTIVITY_PROGRESS_RENDERER_ID = "tui.activity.v1";
const TUI_PROGRESS_RENDERER = Symbol("eve.tui.progress-renderer");

export interface TuiProgressRenderer {
  readonly id: typeof TUI_ACTIVITY_PROGRESS_RENDERER_ID;
  readonly [TUI_PROGRESS_RENDERER]: true;
}

export interface TuiProgressActivityUpdate {
  readonly live: boolean;
  readonly rootTurnId: string;
  readonly text: string;
}

interface TuiProgressRendererRuntime {
  readonly id: string;
  render(input: {
    readonly renderActivity: (update: TuiProgressActivityUpdate) => void;
    readonly snapshot: ProgressSnapshotV1;
    readonly state: unknown;
  }): unknown;
}

/** Creates an update-in-place activity tree for each originating root turn. */
export function tuiActivityProgress(): TuiProgressRenderer {
  return { [TUI_PROGRESS_RENDERER]: true, id: TUI_ACTIVITY_PROGRESS_RENDERER_ID };
}

export function buildTuiProgressRenderers(
  renderers: readonly TuiProgressRenderer[],
): readonly TuiProgressRendererRuntime[] {
  const ids = new Set<string>();
  return renderers.map((renderer) => {
    if (renderer[TUI_PROGRESS_RENDERER] !== true) {
      throw new TypeError("TUI progress renderers must be created by an eve renderer factory.");
    }
    if (ids.has(renderer.id))
      throw new TypeError(`Duplicate TUI progress renderer "${renderer.id}".`);
    ids.add(renderer.id);
    return createTuiActivityRenderer();
  });
}

function createTuiActivityRenderer(): TuiProgressRendererRuntime {
  return {
    id: TUI_ACTIVITY_PROGRESS_RENDERER_ID,
    render({ renderActivity, snapshot }) {
      for (const [rootTurnId, text] of activityMessages(snapshot)) {
        renderActivity({
          live: Object.values(snapshot.work).some(
            (work) => work.rootTurnId === rootTurnId && work.phase === "running",
          ),
          rootTurnId,
          text,
        });
      }
      return undefined;
    },
  };
}

/** TUI-local copy of Slack's bounded root-turn activity projection. */
export function activityMessages(snapshot: ProgressSnapshotV1): ReadonlyMap<string, string> {
  const grouped = new Map<string, ProgressWorkV1[]>();
  for (const work of Object.values(snapshot.work)) {
    const group = grouped.get(work.rootTurnId) ?? [];
    group.push(work);
    grouped.set(work.rootTurnId, group);
  }
  return new Map(
    [...grouped].map(([rootTurnId, work]) => [
      rootTurnId,
      renderWorkTree(
        work,
        Object.values(snapshot.actions).filter((action) => action.rootTurnId === rootTurnId),
        Object.values(snapshot.blockers).filter((blocker) => blocker.rootTurnId === rootTurnId),
      ),
    ]),
  );
}

function renderWorkTree(
  work: readonly ProgressWorkV1[],
  actions: readonly ProgressActionV1[],
  blockers: readonly ProgressBlockerV1[],
): string {
  const byParent = new Map<string | undefined, ProgressWorkV1[]>();
  const ids = new Set(work.map((item) => item.id));
  for (const item of work) {
    const parentId =
      item.parentId !== undefined && ids.has(item.parentId) ? item.parentId : undefined;
    const children = byParent.get(parentId) ?? [];
    children.push(item);
    byParent.set(parentId, children);
  }
  const actionsByParent = new Map<string, ProgressActionV1[]>();
  for (const action of actions) {
    const siblings = actionsByParent.get(action.parentWorkId) ?? [];
    siblings.push(action);
    actionsByParent.set(action.parentWorkId, siblings);
  }
  const blockersByParent = new Map<string, ProgressBlockerV1[]>();
  for (const blocker of blockers) {
    const siblings = blockersByParent.get(blocker.parentWorkId) ?? [];
    siblings.push(blocker);
    blockersByParent.set(blocker.parentWorkId, siblings);
  }
  const lines: string[] = [];
  const append = (line: string): void => {
    if (lines.length < 20) lines.push(line);
  };
  const visit = (item: ProgressWorkV1, depth: number): void => {
    const label = item.kind === "root-turn" ? "Working" : (item.name ?? "Agent work");
    append(`${"  ".repeat(depth)}${phaseIcon(item.phase)} ${label}`);
    for (const blocker of blockersByParent.get(item.id) ?? []) {
      append(
        `${"  ".repeat(depth + 1)}${blockerIcon(blocker.phase)} ${blocker.label ?? blockerLabel(blocker.kind)}`,
      );
    }
    for (const action of actionsByParent.get(item.id) ?? []) {
      append(`${"  ".repeat(depth + 1)}${phaseIcon(action.phase)} ${action.name}`);
    }
    for (const child of byParent.get(item.id) ?? []) visit(child, depth + 1);
  };
  for (const root of byParent.get(undefined) ?? []) visit(root, 0);
  return lines.join("\n");
}

function phaseIcon(phase: ProgressWorkV1["phase"] | ProgressActionV1["phase"]): string {
  switch (phase) {
    case "completed":
      return "✓";
    case "failed":
    case "rejected":
      return "✗";
    case "cancelled":
      return "–";
    case "running":
      return "•";
  }
}

function blockerIcon(phase: ProgressBlockerV1["phase"]): string {
  return phase === "blocked" ? "◌" : phase === "completed" ? "✓" : phase === "failed" ? "✗" : "–";
}

function blockerLabel(kind: ProgressBlockerV1["kind"]): string {
  switch (kind) {
    case "approval":
      return "Waiting for approval…";
    case "authorization":
      return "Waiting for sign-in…";
    case "input":
      return "Waiting for input…";
  }
}

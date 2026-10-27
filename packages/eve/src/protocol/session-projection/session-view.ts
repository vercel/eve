import type { SessionView as Tables, SessionPreviews } from "./tables.js";
import { emptyPreviews } from "./fold.js";
import type { ReceivedEvent } from "./fold.js";

declare const sessionViewBrand: unique symbol;

/** An immutable observation snapshot. Persist events and cursors, not its backing representation. */
export interface SessionView {
  readonly [sessionViewBrand]: true;
  /** What the model last saw. */
  readonly context: {
    /** The input tokens of the latest settled model call; absent before the first one. */
    readonly inputTokens?: number;
    /** The input tokens a request may carry before the history is compacted. */
    readonly limit?: number;
  };
}

interface Snapshot {
  readonly tables: Tables;
  readonly previews: SessionPreviews;
  readonly pending: readonly ReceivedEvent[];
}

// Channels and clients may load independent eve bundles in one process. Like live projections,
// their snapshot registry must be shared without putting table references on public objects.
const KEY = Symbol.for("eve.session-view-registry.v1");
type Shared = typeof globalThis & { [KEY]?: WeakMap<SessionView, Snapshot> };
const snapshots = ((globalThis as Shared)[KEY] ??= new WeakMap());
const contexts = new WeakMap<object, SessionView["context"]>();
// `context` lives on the prototype so a snapshot has no own keys: it stays an opaque handle.
const snapshotPrototype = Object.freeze(
  Object.defineProperty({}, "context", {
    enumerable: true,
    get(this: object) {
      return contexts.get(this);
    },
  }),
);
const immutableRows = new WeakMap<object, object>();

function immutable<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const existing = immutableRows.get(value);
  if (existing !== undefined) return existing as T;
  const copy = structuredClone(value);
  const pending: object[] = [copy];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const child of Object.values(next)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(next);
  }
  immutableRows.set(value, copy);
  immutableRows.set(copy, copy);
  return copy;
}

function table<TRow extends object>(
  rows: Readonly<Record<string, TRow>>,
): Readonly<Record<string, TRow>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, immutable(row)])),
  );
}

/** Internal publication boundary; rows are replaced by the fold and cloned at most once. */
export function snapshotOf(
  view: Tables,
  previews: SessionPreviews = emptyPreviews(),
  pending: readonly ReceivedEvent[] = [],
  limit?: number,
): SessionView {
  const snapshot = Object.freeze(Object.create(snapshotPrototype)) as SessionView;
  contexts.set(snapshot, Object.freeze({ inputTokens: view.lastInputTokens, limit }));
  snapshots.set(snapshot, {
    tables: Object.freeze({
      position: view.position,
      session: immutable(view.session),
      calls: table(view.calls),
      changes: table(view.changes),
      children: table(view.children),
      deliveries: table(view.deliveries),
      interactions: table(view.interactions),
      parts: table(view.parts),
      responses: table(view.responses),
      runs: table(view.runs),
      tasks: table(view.tasks),
      turns: table(view.turns),
      usage: immutable(view.usage),
      selection: immutable(view.selection),
      lastInputTokens: view.lastInputTokens,
    }),
    previews: Object.freeze({ calls: table(previews.calls), parts: table(previews.parts) }),
    pending: immutable(pending),
  });
  return snapshot;
}

export function snapshotState(view: SessionView): Snapshot {
  const state = snapshots.get(view);
  if (state === undefined)
    throw new TypeError(
      "Invalid SessionView. Use emptySessionView() or a snapshot supplied by eve.",
    );
  return state;
}

/** Private access for execution and built-in renderers, never exported by a public entry. */
export function sessionTables(view: SessionView): Tables {
  return snapshotState(view).tables;
}

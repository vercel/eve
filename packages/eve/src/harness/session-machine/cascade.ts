import type { SessionEvent } from "#protocol/session-event.js";
import { FACT_CATALOG, isFactType, isTerminalType } from "#protocol/session-events/catalog.js";
import { copyView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import {
  type Family,
  isOpen,
  openUnder,
  type Ref,
  refOf,
  rowOf,
  scopeOf,
} from "#protocol/session-projection/tree.js";

const TREE_FAMILY: Partial<Record<string, Family>> = {
  call: "call",
  content: "part",
  context: "change",
  delivery: "delivery",
  interaction: "interaction",
  model: "run",
  response: "response",
  task: "task",
  turn: "turn",
};

/**
 * How each family closes when its owner ends: `interrupted` unless a retry superseded the owner,
 * which leaves what it held `abandoned`. A delivery isn't interrupted: the turn that consumed it
 * answered it.
 */
const ENDS_WITH: Record<Exclude<Family, "child" | "part">, { cut: string; superseded: string }> = {
  call: { cut: "interrupted", superseded: "abandoned" },
  change: { cut: "interrupted", superseded: "interrupted" },
  delivery: { cut: "handled", superseded: "handled" },
  interaction: { cut: "interrupted", superseded: "abandoned" },
  response: { cut: "withdrawn", superseded: "abandoned" },
  run: { cut: "interrupted", superseded: "abandoned" },
  task: { cut: "cancelled", superseded: "cancelled" },
  turn: { cut: "cancelled", superseded: "cancelled" },
};

/**
 * An owner's end ends everything under it, in the same commit. For each fact that ends an entity
 * still holding open ones, this closes them first, leaves first, as their families close when
 * an owner ends; the deliveries a turn consumed settle after it. Writers that already closed
 * them leave nothing to add.
 */
export function cascade(view: SessionView, events: readonly SessionEvent[]): SessionEvent[] {
  if (!events.some((event) => isFactType(event.type))) return [...events];
  const scratch = copyView(view);
  const out: SessionEvent[] = [];
  const apply = (event: SessionEvent) => {
    foldReceivedEvent(scratch, { ...event, meta: { endOfLine: false } });
    out.push(stamped(scratch, event));
  };
  // What the commit closes itself, it closes its own way.
  const explicit = new Set(
    events.flatMap((event) => {
      const ref = endedBy(view, event, false);
      return ref === undefined || ref === "session" ? [] : [`${ref.family}:${ref.id}`];
    }),
  );
  const cascaded = (refs: readonly Ref[]) =>
    refs.filter((ref) => !explicit.has(`${ref.family}:${ref.id}`));
  for (const event of events) {
    const owner = endedBy(scratch, event);
    if (owner === undefined) {
      apply(event);
      continue;
    }
    const { outcome, reason } = event.data as {
      readonly outcome?: string;
      readonly reason?: string;
    };
    const why = { reason: reasonFor(owner, outcome, reason), superseded: outcome === "abandoned" };
    // What the owner still holds once its end is folded: a run that completes hands the calls
    // it made on to its turn, so they don't close with it.
    const probe = copyView(scratch);
    foldReceivedEvent(probe, { ...event, meta: { endOfLine: false } });
    // A turn's deliveries settle after it; `session.ended` is always last.
    const under = cascaded(openUnder(probe, owner));
    const after = (ref: Ref) => ref.family === "delivery" && owner !== "session";
    for (const ref of under.filter((entry) => !after(entry)))
      apply(closing(scratch, ref, why, owner === "session"));
    apply(event);
    for (const ref of under.filter(after)) apply(closing(scratch, ref, why, false));
  }
  return out;
}

/**
 * A fact with the owners it belongs to, read from the tree: those of the entity it's about, or
 * of the owner it names. Readers that don't fold place it by them. Progress keeps its own,
 * since what it previews isn't in the tables yet.
 */
function stamped(view: SessionView, event: SessionEvent): SessionEvent {
  if (!isFactType(event.type)) return event;
  const descriptor = FACT_CATALOG[event.type];
  const data = event.data as Readonly<Record<string, unknown>>;
  const family = TREE_FAMILY[descriptor.family];
  const id = data[descriptor.idField];
  const about =
    family !== undefined && typeof id === "string" && rowOf(view, family, id) !== undefined
      ? { family, id }
      : refOf(data.owner as Readonly<Record<string, string>> | undefined);
  if (about === undefined) return event;
  const scope = scopeOf(view, about);
  return Object.keys(scope).length === 0 ? event : ({ ...event, scope } as SessionEvent);
}

/** The facts that close everything open under `owner`, leaves first, as it its owner cut it. */
export function closeUnder(view: SessionView, owner: Ref, reason: string): SessionEvent[] {
  const scratch = copyView(view);
  return openUnder(scratch, owner).map((ref) => {
    const fact = closing(scratch, ref, { reason, superseded: false }, false);
    foldReceivedEvent(scratch, { ...fact, meta: { endOfLine: false } });
    return fact;
  });
}

/** Why what an owner held closed, as its readers already see it. */
function reasonFor(owner: Ref | "session", outcome?: string, reason?: string): string {
  if (owner === "session") return "session-ended";
  switch (owner.family) {
    case "turn":
      return outcome === "completed" ? "turn-ended" : `turn-${outcome}`;
    case "run":
      return outcome === "abandoned" ? "model-call-retried" : "steered";
    case "task":
      return reason ?? "task-ended";
    case "interaction":
      return reason ?? `interaction-${outcome ?? "ended"}`;
    case "change":
      return "context-change-failed";
    default:
      return `${owner.family}-${outcome ?? "ended"}`;
  }
}

/** The entity a fact ends, if it's open; the session for `session.ended`. */
function endedBy(
  view: SessionView,
  event: SessionEvent,
  onlyOpen = true,
): Ref | "session" | undefined {
  if (!isFactType(event.type) || !isTerminalType(event.type)) return undefined;
  if (event.type === "session.ended") return "session";
  const descriptor = FACT_CATALOG[event.type];
  const family = TREE_FAMILY[descriptor.family];
  const id = (event.data as Readonly<Record<string, unknown>>)[descriptor.idField];
  if (family === undefined || typeof id !== "string") return undefined;
  const ref = { family, id };
  return !onlyOpen || isOpen(view, ref) ? ref : undefined;
}

function closing(
  view: SessionView,
  ref: Ref,
  why: { readonly reason: string; readonly superseded: boolean },
  sessionEnded: boolean,
): SessionEvent {
  const { reason, superseded } = why;
  const ends = ENDS_WITH[ref.family as keyof typeof ENDS_WITH];
  const outcome = superseded ? ends.superseded : ends.cut;
  const scope = scopeOf(view, ref);
  switch (ref.family) {
    case "interaction":
      return {
        data: { interactionId: ref.id, outcome, reason },
        scope,
        type: "interaction.settled",
      } as SessionEvent;
    case "response":
      return {
        data: { outcome, reason, responseId: ref.id },
        type: "response.settled",
      } as SessionEvent;
    case "call":
      return {
        data: { callId: ref.id, outcome, reason },
        scope,
        type: "call.settled",
      } as SessionEvent;
    case "run":
      return { data: { outcome, runId: ref.id }, scope, type: "model.settled" } as SessionEvent;
    case "task":
      return {
        data: { outcome, reason, taskId: ref.id },
        scope,
        type: "task.ended",
      } as SessionEvent;
    case "change":
      return {
        data: { changeId: ref.id, kind: rowOf(view, "change", ref.id)!.kind, outcome },
        scope,
        type: "context.settled",
      } as SessionEvent;
    case "delivery": {
      const turnId = rowOf(view, "delivery", ref.id)?.turnId;
      return (
        sessionEnded || turnId === undefined
          ? { data: { deliveryId: ref.id, outcome: "failed", reason }, type: "delivery.settled" }
          : { data: { deliveryId: ref.id, outcome, turnId }, type: "delivery.settled" }
      ) as SessionEvent;
    }
    default: {
      const reply = rowOf(view, "turn", ref.id)?.reply;
      return {
        data: {
          outcome,
          ...(reply !== undefined && reply.length > 0 && { reply }),
          turnId: ref.id,
        },
        scope,
        type: "turn.settled",
      } as SessionEvent;
    }
  }
}

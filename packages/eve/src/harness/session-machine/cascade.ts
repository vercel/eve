import type { Commit } from "#harness/types.js";
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

export function cascade(view: SessionView, events: readonly SessionEvent[]): SessionEvent[] {
  if (!events.some((event) => isFactType(event.type))) return [...events];
  const scratch = copyView(view);
  const out: SessionEvent[] = [];
  const apply = (event: SessionEvent) => {
    foldReceivedEvent(scratch, { ...event, meta: { endOfLine: false } });
    out.push(stamped(scratch, event));
  };
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
    const probe = copyView(scratch);
    foldReceivedEvent(probe, { ...event, meta: { endOfLine: false } });
    const under = cascaded(openUnder(probe, owner));
    const after = (ref: Ref) => ref.family === "delivery" && owner !== "session";
    for (const ref of under.filter((entry) => !after(entry)))
      apply(closing(scratch, ref, why, owner === "session"));
    apply(event);
    for (const ref of under.filter(after)) apply(closing(scratch, ref, why, false));
  }
  return out;
}

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

export function closeUnder(view: SessionView, owner: Ref, reason: string): SessionEvent[] {
  const scratch = copyView(view);
  return openUnder(scratch, owner).map((ref) => {
    const fact = closing(scratch, ref, { reason, superseded: false }, false);
    foldReceivedEvent(scratch, { ...fact, meta: { endOfLine: false } });
    return fact;
  });
}

export function supersede(view: SessionView, which: (ref: Ref) => boolean, reason: string): Commit {
  const scratch = copyView(view);
  const facts: SessionEvent[] = [];
  for (const ref of openUnder(scratch, "session")) {
    if (!isOpen(scratch, ref) || !which(ref)) continue;
    const fact = closing(scratch, ref, { reason, superseded: true }, false);
    foldReceivedEvent(scratch, { ...fact, meta: { endOfLine: false } });
    facts.push(fact);
  }
  const closures: readonly SessionEvent[] = facts;
  return closures as Commit;
}

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

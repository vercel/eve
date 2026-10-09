// The stream checker: the lifecycle rules, checked line by line. Tests run it over golden streams,
// and development runs it in the writer, so a producer mistake surfaces where it happens.
//
// It checks what a fact may assume about the entities it names: that they were introduced, that
// each ends once with an outcome from its closed set, and that whatever ends with a container ends
// in the container's commit. Facts and progress of unknown types pass, as readers ignore them.

import {
  FACT_CATALOG,
  isFactType,
  isKnownOutcome,
  isProgressType,
  isTerminalType,
  type Family,
} from "./catalog.js";
import type { StoredLine } from "./envelope.js";
import type { Fact, Progress } from "./facts.js";
import type { SessionView } from "../session-projection/tables.js";

export interface Violation {
  readonly position: number;
  /** The fact's index in its commit; absent for a progress record or the whole line. */
  readonly index?: number;
  readonly type?: string;
  readonly rule: ViolationRule;
  readonly message: string;
}

export type ViolationRule =
  | "envelope"
  | "schema"
  | "introduce-before-reference"
  | "introduced-twice"
  | "one-terminal"
  | "closed-outcome"
  | "closure"
  | "after-session-end"
  | "one-open-turn"
  | "progress";

export interface StreamChecker {
  /** Checks the next line. Positions must increase; a repeated position is a duplicate, skipped. */
  check(line: StoredLine, position: number): readonly Violation[];
}

interface Entity {
  readonly family: Family;
  open: boolean;
  /** For runs: the turn or change that owns the run. */
  readonly turnId?: string;
  readonly changeId?: string;
  /** For calls: the run or call that owns the call. */
  readonly runId?: string;
  readonly parentCallId?: string;
  /** For calls: the task that serves the call. */
  taskId?: string;
  /** For interactions: what they're about. */
  readonly subject?: Readonly<Record<string, string>>;
  /** For responses: their interaction. */
  readonly interactionId?: string;
}

export function createStreamChecker(
  options: {
    /** Schema validation, from `schemas.ts`, for tests and development. */
    readonly validate?: (record: unknown, kind: "fact" | "progress") => string | undefined;
    /** Check from a checkpoint's operational view, including retained ownership ancestors.
     * Forgotten history cannot establish global identity uniqueness; full-stream checks can.
     */
    readonly seed?: SessionView;
  } = {},
): StreamChecker {
  const entities = new Map<string, Entity>();
  const parts = new Set<string>();
  const announcedParts = new Set<string>();
  const announcedCalls = new Set<string>();
  let lastPosition = -1;
  let sessionStarted = false;
  let sessionEnded = false;
  let openTurn: string | undefined;

  const key = (family: Family, id: string) => `${family}:${id}`;
  const get = (family: Family, id: unknown) =>
    typeof id === "string" ? entities.get(key(family, id)) : undefined;

  const seed = options.seed;
  if (seed !== undefined) {
    lastPosition = seed.position - 1;
    sessionStarted = seed.session.status !== "new";
    sessionEnded = seed.session.status === "ended";
    const add = (family: Family, id: string, entity: Omit<Entity, "family">) =>
      entities.set(key(family, id), { ...entity, family });
    for (const row of Object.values(seed.deliveries))
      add("delivery", row.deliveryId, { open: row.status !== "settled" });
    for (const row of Object.values(seed.turns)) {
      const open = row.status !== "settled";
      add("turn", row.turnId, { open });
      if (open) openTurn = row.turnId;
    }
    for (const row of Object.values(seed.changes))
      add("context", row.changeId, {
        open: row.status !== "settled",
        turnId: row.turnId,
      });
    for (const row of Object.values(seed.runs))
      add("model", row.runId, {
        open: row.status !== "settled",
        turnId: "turnId" in row.owner ? row.owner.turnId : undefined,
        changeId: "changeId" in row.owner ? row.owner.changeId : undefined,
      });
    for (const row of Object.values(seed.calls))
      add("call", row.callId, {
        open: row.status !== "settled",
        taskId: row.taskId,
        runId: "runId" in row.owner ? row.owner.runId : undefined,
        parentCallId: "callId" in row.owner ? row.owner.callId : undefined,
      });
    for (const row of Object.values(seed.tasks))
      add("task", row.taskId, { open: row.status !== "ended" });
    for (const row of Object.values(seed.interactions))
      add("interaction", row.interactionId, {
        open: row.status !== "settled",
        subject: row.subject,
      });
    for (const row of Object.values(seed.responses))
      add("response", row.responseId, {
        open: row.status !== "settled",
        interactionId: row.interactionId,
      });
    for (const row of Object.values(seed.parts)) parts.add(row.partId);
  }

  return {
    check(line, position) {
      const violations: Violation[] = [];
      if (position <= lastPosition) return violations;
      lastPosition = position;

      const report = (
        rule: ViolationRule,
        message: string,
        at: { readonly index?: number; readonly type?: string } = {},
      ) => violations.push({ message, position, rule, ...at });

      if ("progress" in line) {
        checkProgress(line.progress, report);
        return violations;
      }
      if (!Array.isArray(line.facts) || line.facts.length === 0) {
        report("envelope", "A commit holds at least one fact.");
        return violations;
      }

      const closed: { readonly family: Family; readonly id: string; readonly index: number }[] = [];
      line.facts.forEach((raw, index) => {
        const fact = raw as Fact;
        const at = { index, type: fact?.type };
        if (fact === null || typeof fact !== "object" || typeof fact.type !== "string") {
          report("envelope", "A fact has no type.", at);
          return;
        }
        if (fact.type.split(".").length !== 2) {
          report("envelope", `"${fact.type}" isn't family.verb.`, at);
        }
        if (!isFactType(fact.type)) return;
        const invalid = options.validate?.(fact, "fact");
        if (invalid !== undefined) {
          report("schema", invalid, at);
          return;
        }
        if (sessionEnded) {
          report("after-session-end", `${fact.type} follows session.ended.`, at);
          return;
        }
        if (!sessionStarted && fact.type !== "session.started") {
          report("introduce-before-reference", `${fact.type} precedes session.started.`, at);
        }
        const fail = (rule: ViolationRule, message: string) => report(rule, message, at);
        const ended = apply(fact, fail);
        if (ended !== undefined) closed.push({ ...ended, index });
      });

      for (const container of closed) {
        for (const message of openInside(container.family, container.id)) {
          report("closure", message, { index: container.index });
        }
      }
      return violations;
    },
  };

  /** Applies one known fact; returns the entity it ended, if any. */
  function apply(
    fact: Fact,
    fail: (rule: ViolationRule, message: string) => void,
  ): { readonly family: Family; readonly id: string } | undefined {
    const descriptor = FACT_CATALOG[fact.type];
    const data = fieldsOf(fact.data);
    const requireKnown = (family: Family, id: unknown, what: string) => {
      const entity = get(family, id);
      if (entity === undefined) {
        fail(
          "introduce-before-reference",
          `${fact.type} names ${what} "${String(id)}" before it was introduced.`,
        );
      }
      return entity;
    };

    if (isTerminalType(fact.type) && !isKnownOutcome(fact.type, data.outcome)) {
      fail(
        "closed-outcome",
        `${fact.type} has outcome "${String(data.outcome)}", outside its closed set.`,
      );
    }

    switch (fact.type) {
      case "session.started":
        if (sessionStarted) fail("introduced-twice", "session.started appears twice.");
        sessionStarted = true;
        return undefined;
      case "session.ended":
        sessionEnded = true;
        return { family: "session", id: "" };
      case "delivery.consumed":
        requireKnown("delivery", data.deliveryId, "delivery");
        requireKnown("turn", data.turnId, "turn");
        break;
      case "turn.started":
        if (openTurn !== undefined) {
          fail(
            "one-open-turn",
            `turn ${String(data.turnId)} started while turn ${openTurn} is open.`,
          );
        }
        openTurn = String(data.turnId);
        break;
      case "model.requested": {
        const owner = data.owner as Readonly<Record<string, string>>;
        if ("turnId" in owner) requireKnown("turn", owner.turnId, "turn");
        else requireKnown("context", owner.changeId, "context change");
        break;
      }
      case "content.completed": {
        const run = requireKnown("model", data.runId, "run");
        if (run !== undefined && !run.open) {
          fail("closure", `part "${String(data.partId)}" completes after its run settled.`);
        }
        if (parts.has(String(data.partId))) {
          fail("one-terminal", `part "${String(data.partId)}" completes twice.`);
        }
        parts.add(String(data.partId));
        return undefined;
      }
      case "call.requested": {
        const owner = data.owner as Readonly<Record<string, string>>;
        if ("runId" in owner) requireKnown("model", owner.runId, "run");
        else requireKnown("call", owner.callId, "call");
        break;
      }
      case "call.started": {
        const call = requireKnown("call", data.callId, "call");
        if (typeof data.taskId === "string") {
          requireKnown("task", data.taskId, "task");
          if (call !== undefined) call.taskId = data.taskId;
        }
        break;
      }
      case "task.started":
        requireKnown("call", (data.startedBy as Readonly<Record<string, string>>).callId, "call");
        break;
      case "interaction.opened": {
        const subject = data.subject as Readonly<Record<string, string>>;
        const [field, id] = Object.entries(subject)[0] ?? [];
        const family = subjectFamily(field);
        if (family !== undefined) requireKnown(family, id, field ?? "subject");
        break;
      }
      case "response.submitted":
        requireKnown("interaction", data.interactionId, "interaction");
        requireKnown("delivery", data.deliveryId, "delivery");
        break;
      case "child.opened": {
        const owner = data.owner as Readonly<Record<string, string>>;
        if ("callId" in owner) requireKnown("call", owner.callId, "call");
        else requireKnown("task", owner.taskId, "task");
        return undefined;
      }
      case "context.started":
        if (typeof data.turnId === "string") requireKnown("turn", data.turnId, "turn");
        break;
      case "usage.recorded": {
        const owner = data.owner as Readonly<Record<string, string>> | undefined;
        if (owner !== undefined) {
          if ("runId" in owner) requireKnown("model", owner.runId, "run");
          else if ("callId" in owner) requireKnown("call", owner.callId, "call");
          else requireKnown("context", owner.changeId, "context change");
        }
        return undefined;
      }
      default:
        break;
    }

    const id = data[descriptor.idField];
    if (typeof id !== "string") return undefined;
    const family = descriptor.family;
    const existing = get(family, id);
    switch (descriptor.role) {
      case "introduces":
        if (existing !== undefined) {
          fail("introduced-twice", `${fact.type} introduces ${family} "${id}" again.`);
          return undefined;
        }
        entities.set(key(family, id), introduce(fact, data));
        return undefined;
      case "updates":
        if (existing === undefined) {
          fail(
            "introduce-before-reference",
            `${fact.type} names ${family} "${id}" before it was introduced.`,
          );
        } else if (!existing.open) {
          fail("one-terminal", `${fact.type} updates ${family} "${id}" after it ended.`);
        }
        return undefined;
      case "terminal":
        if (existing === undefined) {
          fail(
            "introduce-before-reference",
            `${fact.type} ends ${family} "${id}" before it was introduced.`,
          );
          return undefined;
        }
        if (!existing.open) {
          fail("one-terminal", `${fact.type} ends ${family} "${id}" a second time.`);
          return undefined;
        }
        existing.open = false;
        if (family === "turn" && openTurn === id) openTurn = undefined;
        return { family, id };
      default:
        return undefined;
    }
  }

  /** What still stands open inside a container its commit ended. */
  function openInside(family: Family, id: string): string[] {
    const open: string[] = [];
    for (const [entityKey, entity] of entities) {
      if (!entity.open) continue;
      const entityId = entityKey.slice(entity.family.length + 1);
      if (belongsTo(entity, family, id)) {
        open.push(
          `${entity.family} "${entityId}" is still open when ${family === "session" ? "the session" : `${family} "${id}"`} ends.`,
        );
      }
    }
    return open;
  }

  function belongsTo(entity: Entity, family: Family, id: string): boolean {
    switch (family) {
      case "session":
        return entity.family !== "child";
      case "turn":
        if (entity.family === "model") return modelTurn(entity) === id;
        if (entity.family === "call") return entity.taskId === undefined && callTurn(entity) === id;
        if (entity.family === "interaction") return subjectTurn(entity) === id;
        if (entity.family === "context") return entity.turnId === id;
        return false;
      case "context":
        return entity.family === "model" && entity.changeId === id;
      case "task":
        if (entity.family === "call") return entity.taskId === id;
        if (entity.family === "interaction") return entity.subject?.taskId === id;
        return false;
      case "interaction":
        return entity.family === "response" && entity.interactionId === id;
      default:
        return false;
    }
  }

  /** The turn a call belongs to, through its run, or its parent call. */
  function modelTurn(model: Entity): string | undefined {
    return model.turnId ?? get("context", model.changeId)?.turnId;
  }

  function callTurn(call: Entity): string | undefined {
    const seen = new Set<Entity>();
    let current: Entity | undefined = call;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      if (current.taskId !== undefined) return undefined;
      if (current.runId !== undefined) {
        const model = get("model", current.runId);
        return model === undefined ? undefined : modelTurn(model);
      }
      current = get("call", current.parentCallId);
    }
    return undefined;
  }

  function subjectTurn(interaction: Entity): string | undefined {
    const subject = interaction.subject ?? {};
    if (subject.turnId !== undefined) return subject.turnId;
    if (subject.callId !== undefined) {
      const call = get("call", subject.callId);
      return call === undefined || call.taskId !== undefined ? undefined : callTurn(call);
    }
    return undefined;
  }

  function checkProgress(
    raw: unknown,
    report: (rule: ViolationRule, message: string, at?: { readonly type?: string }) => void,
  ): void {
    const progress = raw as Progress;
    if (progress === null || typeof progress !== "object" || !isProgressType(progress.type)) return;
    const at = { type: progress.type };
    const invalid = options.validate?.(progress, "progress");
    if (invalid !== undefined) {
      report("schema", invalid, at);
      return;
    }
    if (sessionEnded) {
      report("after-session-end", `${progress.type} follows session.ended.`, at);
      return;
    }
    switch (progress.type) {
      case "content.delta": {
        const { partId, kind } = progress.data;
        if (parts.has(partId)) {
          report("progress", `content.delta for part "${partId}" after it completed.`, at);
        } else if (!announcedParts.has(partId)) {
          if (kind === undefined) {
            report("progress", `content.delta for unannounced part "${partId}" has no kind.`, at);
          }
          const run = get("model", progress.scope?.runId);
          if (run === undefined || !run.open) {
            report("progress", `content.delta announces part "${partId}" outside an open run.`, at);
          }
          announcedParts.add(partId);
        }
        return;
      }
      case "call.input": {
        const { callId, name } = progress.data;
        const call = get("call", callId);
        if (call !== undefined && !call.open) {
          report("progress", `call.input for call "${callId}" after it settled.`, at);
        } else if (call === undefined && !announcedCalls.has(callId)) {
          if (name === undefined) {
            report("progress", `call.input for unannounced call "${callId}" has no name.`, at);
          }
          announcedCalls.add(callId);
        }
        return;
      }
      case "call.progress": {
        const call = get("call", progress.data.callId);
        if (call === undefined || !call.open) {
          report(
            "progress",
            `call.progress for call "${progress.data.callId}" that isn't running.`,
            at,
          );
        }
        return;
      }
    }
  }
}

function introduce(fact: Fact, data: Readonly<Record<string, unknown>>): Entity {
  const family = FACT_CATALOG[fact.type].family;
  switch (fact.type) {
    case "model.requested": {
      const owner = data.owner as Readonly<Record<string, string>>;
      return { changeId: owner.changeId, family, open: true, turnId: owner.turnId };
    }
    case "call.requested": {
      const owner = data.owner as Readonly<Record<string, string>>;
      return { family, open: true, parentCallId: owner.callId, runId: owner.runId };
    }
    case "interaction.opened":
      return { family, open: true, subject: data.subject as Readonly<Record<string, string>> };
    case "response.submitted":
      return { family, interactionId: String(data.interactionId), open: true };
    case "context.started":
      return {
        family,
        open: true,
        turnId: typeof data.turnId === "string" ? data.turnId : undefined,
      };
    case "child.opened":
      return { family, open: false };
    default:
      return { family, open: true };
  }
}

function fieldsOf(data: object): Readonly<Record<string, unknown>> {
  return data as Readonly<Record<string, unknown>>;
}

function subjectFamily(field: string | undefined): Family | undefined {
  switch (field) {
    case "callId":
      return "call";
    case "turnId":
      return "turn";
    case "taskId":
      return "task";
    case "responseId":
      return "response";
    default:
      return undefined;
  }
}

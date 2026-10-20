// The stream checker: the lifecycle rules, checked line by line. Tests run it over golden streams,
// and development runs it in the writer, so a producer mistake surfaces where it happens.
//
// It checks what a fact may assume about the entities it names: that they were introduced, that
// each ends once with an outcome from its closed set, and that whatever an owner holds ends in the
// owner's commit. It folds each fact into its own copy of the shared view and reads ownership from
// the one tree, so its rules hold for every family alike. Facts and progress of unknown types
// pass, as readers ignore them.

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
import { copyView, emptySessionView, foldReceivedEvent } from "../session-projection/fold.js";
import type { InteractionRow, SessionView } from "../session-projection/tables.js";
import {
  activeTurn,
  interactionOwner,
  subjectTurn,
  waiting,
} from "../session-projection/selectors.js";
import {
  type Family as TreeFamily,
  isOpen,
  openUnder,
  type Ref,
  refOf,
  rowOf,
} from "../session-projection/tree.js";

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
  | "attempts"
  | "progress"
  | "paused-on-person"
  | "serves-running-task"
  | "batch-settles-together";

export interface StreamChecker {
  /** Checks the next line. Positions must increase; a repeated position is a duplicate, skipped. */
  check(line: StoredLine, position: number): readonly Violation[];
}

/** The tree's family for a catalog family; `undefined` for the session, usage, and children. */
const TREE_FAMILY: Partial<Record<Family, TreeFamily>> = {
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

const ID_FIELDS: Readonly<Record<string, TreeFamily>> = {
  callId: "call",
  changeId: "change",
  deliveryId: "delivery",
  interactionId: "interaction",
  responseId: "response",
  runId: "run",
  taskId: "task",
  turnId: "turn",
};

/** The entities a fact names besides its own: its `…Id` fields, and keyed owners. */
function referencesOf(data: Readonly<Record<string, unknown>>, ownId: string): Ref[] {
  const refs: Ref[] = [];
  for (const [field, value] of Object.entries(data)) {
    if (field === ownId) continue;
    const family = ID_FIELDS[field];
    if (family !== undefined && typeof value === "string") refs.push({ family, id: value });
    if (field === "owner" || field === "subject" || field === "startedBy") {
      const ref = refOf(value as Readonly<Record<string, string>> | undefined);
      if (ref !== undefined) refs.push(ref);
    }
  }
  return refs;
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
  const view = options.seed === undefined ? emptySessionView() : copyView(options.seed);
  const announcedParts = new Set<string>();
  const announcedCalls = new Set<string>();
  let lastPosition = view.position - 1;

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
        foldReceivedEvent(view, { meta: { position: { index: 0, line: position } }, type: "" });
        return violations;
      }
      if (!Array.isArray(line.facts) || line.facts.length === 0) {
        report("envelope", "A commit holds at least one fact.");
        return violations;
      }

      const closed: { readonly ref: Ref | "session"; readonly index: number }[] = [];
      line.facts.forEach((raw, index) => {
        const fact = raw as Fact;
        const at = { index, type: fact?.type };
        const fail = (rule: ViolationRule, message: string) => report(rule, message, at);
        if (fact === null || typeof fact !== "object" || typeof fact.type !== "string") {
          fail("envelope", "A fact has no type.");
          return;
        }
        if (fact.type.split(".").length !== 2)
          fail("envelope", `"${fact.type}" isn't family.verb.`);
        if (isFactType(fact.type)) {
          const invalid = options.validate?.(fact, "fact");
          if (invalid !== undefined) {
            fail("schema", invalid);
            return;
          }
          if (view.session.status === "ended") {
            fail("after-session-end", `${fact.type} follows session.ended.`);
            return;
          }
          const ended = checkFact(fact, fail);
          if (ended !== undefined) closed.push({ index, ref: ended });
        }
        foldReceivedEvent(view, {
          ...fact,
          meta: {
            at: line.at,
            endOfLine: index === line.facts.length - 1,
            position: { index, line: position },
          },
        });
      });

      checkWaitPromises(line.facts as readonly Fact[], report);
      for (const { index, ref } of closed) {
        const owner = ref === "session" ? "the session" : `${ref.family} "${ref.id}"`;
        for (const open of openUnder(view, ref)) {
          report("closure", `${open.family} "${open.id}" is still open when ${owner} ends.`, {
            index,
          });
        }
      }
      return violations;
    },
  };

  /** Checks one known fact against the view before it; returns what it ends, if anything. */
  function checkFact(
    fact: Fact,
    fail: (rule: ViolationRule, message: string) => void,
  ): Ref | "session" | undefined {
    const descriptor = FACT_CATALOG[fact.type];
    const data = fact.data as Readonly<Record<string, unknown>>;
    if (isTerminalType(fact.type) && !isKnownOutcome(fact.type, data.outcome)) {
      fail(
        "closed-outcome",
        `${fact.type} has outcome "${String(data.outcome)}", outside its closed set.`,
      );
    }
    if (fact.type === "session.started") {
      if (view.session.status !== "new") fail("introduced-twice", "session.started appears twice.");
      return undefined;
    }
    if (view.session.status === "new") {
      fail("introduce-before-reference", `${fact.type} precedes session.started.`);
    }
    if (fact.type === "session.ended") return "session";
    for (const ref of referencesOf(data, descriptor.idField)) {
      if (rowOf(view, ref.family, ref.id) === undefined)
        fail(
          "introduce-before-reference",
          `${fact.type} names ${ref.family} "${ref.id}" before it was introduced.`,
        );
    }
    if (fact.type === "turn.started") {
      const open = activeTurn(view);
      if (open !== undefined)
        fail(
          "one-open-turn",
          `turn ${String(data.turnId)} started while turn ${open.turnId} is open.`,
        );
    }
    if (fact.type === "turn.paused") {
      for (const { interactionId } of fact.data.awaiting) {
        const row = view.interactions[interactionId];
        const under =
          row !== undefined &&
          (interactionOwner(view, row).turnId === fact.data.turnId ||
            subjectTurn(view, row) === fact.data.turnId);
        if (row?.status !== "open" || !under)
          fail(
            "paused-on-person",
            `turn.paused awaits "${interactionId}", not open under its turn.`,
          );
      }
    }
    if (fact.type === "call.started" && fact.data.taskId !== undefined) {
      if (view.tasks[fact.data.taskId]?.status === "ended")
        fail(
          "serves-running-task",
          `call.started names task "${fact.data.taskId}" after it ended.`,
        );
    }
    const family = TREE_FAMILY[descriptor.family];
    const id = data[descriptor.idField];
    if (family === undefined || typeof id !== "string") return undefined;
    const ref = { family, id };
    const row = rowOf(view, family, id);
    switch (descriptor.role) {
      case "introduces":
        if (row !== undefined)
          fail("introduced-twice", `${fact.type} introduces ${family} "${id}" again.`);
        return undefined;
      case "complete": {
        if (row !== undefined) fail("one-terminal", `${family} "${id}" completes twice.`);
        const run = refOf({ runId: String(data.runId) })!;
        if (rowOf(view, run.family, run.id) !== undefined && !isOpen(view, run))
          fail("closure", `${family} "${id}" completes after its run settled.`);
        return undefined;
      }
      case "updates":
        if (row === undefined)
          fail(
            "introduce-before-reference",
            `${fact.type} names ${family} "${id}" before it was introduced.`,
          );
        else if (!isOpen(view, ref))
          fail("one-terminal", `${fact.type} updates ${family} "${id}" after it ended.`);
        else checkAttempt(fact, fail);
        return undefined;
      case "terminal":
        if (row === undefined) {
          fail(
            "introduce-before-reference",
            `${fact.type} ends ${family} "${id}" before it was introduced.`,
          );
          return undefined;
        }
        if (!isOpen(view, ref)) {
          fail("one-terminal", `${fact.type} ends ${family} "${id}" a second time.`);
          return undefined;
        }
        return ref;
      default:
        return undefined;
    }
  }

  /**
   * What a line that announces a wait or decides approvals promises, checked once it folds: an
   * announced turn waits on a person, and a person's decision settles its whole batch.
   */
  function checkWaitPromises(
    facts: readonly Fact[],
    report: (rule: ViolationRule, message: string, at: { readonly index: number }) => void,
  ): void {
    facts.forEach((fact, index) => {
      const turnId =
        fact?.type === "turn.paused" ||
        (fact?.type === "delivery.settled" && fact.data.outcome === "awaiting-input")
          ? fact.data.turnId
          : undefined;
      if (turnId !== undefined && waiting(view, turnId)?.on !== "person")
        report("paused-on-person", `${fact.type} announces a wait turn ${turnId} doesn't have.`, {
          index,
        });
      if (fact?.type !== "interaction.settled") return;
      if (fact.data.outcome !== "accepted" && fact.data.outcome !== "declined") return;
      const own = (row: InteractionRow | undefined) =>
        row?.request.kind === "approval" && row.origin === undefined;
      const row = view.interactions[fact.data.interactionId];
      if (!own(row)) return;
      const open = Object.values(view.interactions).filter(
        (other) =>
          own(other) && other.introducedAt === row!.introducedAt && other.status === "open",
      );
      if (open.length > 0)
        report("batch-settles-together", `"${row!.interactionId}" settled apart from its batch.`, {
          index,
        });
    });
  }

  /** A run's attempts go up, one `model.started` each; `model.retried` names the current one. */
  function checkAttempt(fact: Fact, fail: (rule: ViolationRule, message: string) => void): void {
    if (fact.type !== "model.started" && fact.type !== "model.retried") return;
    const { attempt, runId } = fact.data;
    const current = view.runs[runId]?.attempt;
    if (fact.type === "model.started" && current !== undefined && attempt <= current)
      fail("attempts", `run "${runId}" starts attempt ${attempt} after attempt ${current}.`);
    if (fact.type === "model.retried" && attempt !== current)
      fail("attempts", `run "${runId}" retries attempt ${attempt}, but its current is ${current}.`);
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
    if (view.session.status === "ended") {
      report("after-session-end", `${progress.type} follows session.ended.`, at);
      return;
    }
    switch (progress.type) {
      case "content.delta": {
        const { partId, kind } = progress.data;
        if (view.parts[partId] !== undefined) {
          report("progress", `content.delta for part "${partId}" after it completed.`, at);
        } else if (!announcedParts.has(partId)) {
          if (kind === undefined) {
            report("progress", `content.delta for unannounced part "${partId}" has no kind.`, at);
          }
          const runId = progress.scope?.runId;
          if (runId === undefined || !isOpen(view, { family: "run", id: runId })) {
            report("progress", `content.delta announces part "${partId}" outside an open run.`, at);
          }
          announcedParts.add(partId);
        }
        return;
      }
      case "call.input": {
        const { callId, name } = progress.data;
        const call = view.calls[callId];
        if (call !== undefined && call.status === "settled") {
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
        if (!isOpen(view, { family: "call", id: progress.data.callId })) {
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

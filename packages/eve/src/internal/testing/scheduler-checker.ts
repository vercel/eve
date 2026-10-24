import { createHash } from "node:crypto";

import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { arrivalsOf, urgency } from "#execution/session/arrivals.js";
import { principalOf } from "#execution/session/principal.js";
import { on, type SchedulerEvent } from "#execution/session/scheduler/events.js";
import { heldDeliveries } from "#execution/session/scheduler/held.js";
import { next, type Next, type SessionReading } from "#execution/session/scheduler/next.js";
import {
  initialScheduler,
  turnOf,
  type Scheduler,
  type StepEnd,
} from "#execution/session/scheduler/state.js";
import type { SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type {
  DeliveryRow,
  InteractionRow,
  TurnRow,
  SessionView,
} from "#protocol/session-projection/tables.js";

// The session's scheduler, checked exhaustively to a bound, with nothing but itself: production's
// `next` and `on`, and a small world that answers what the scheduler asks. There's no harness and
// no model call, so a transition takes microseconds, and the checker reaches far more of the
// scheduler than the explorer can: sign-ins, tasks and their waits, children, delegated callers,
// budgets, hand-offs, and every control.
//
// The world keeps what the session's durable state would say (`Durable`), and every answer keeps
// it consistent, as each step keeps its contract: a step takes what it's given onto the stream,
// closes what it answered, and leaves the turn waiting only on what's open. That contract is an
// assumption here; the explorer checks the real step keeps it.
//
// The world answers every request at once, and moves only where the session waits: at a step,
// whose result it picks and beside which something may arrive, and at a wait, where something
// arrives. What resolves something open (an answer, a callback, a result, a task's end) is always
// possible; anything new costs one of `Bounds.sends`, so every path ends.

const ALICE = person("alice");
const BOB = person("bob");

function person(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId,
    principalType: "user",
  };
}

export type Feature =
  /** Alice cancels, resets, clears, and compacts; a session times out; a payload is unreadable. */
  | "controls"
  /** A step asks for a sign-in, which a callback answers. */
  | "sign-ins"
  /** A step starts a task, waits on tasks, or calls `eve__task_wait` and `eve__task_cancel`. */
  | "tasks"
  /** Children: routing takes what they asked for, opens them, or stops the turn. */
  | "children"
  /** A delegated caller sends the session's messages, and hears how its turns end. */
  | "delegated"
  /** Messages that only queue (`turnPolicy: "queue"`). */
  | "queue"
  /** A step parks on a budget prompt, which holds the turn open between turns. */
  | "budget"
  /** A step compacts, and the session may move to a fresh run or another deployment. */
  | "handoff"
  /** A step ends the session. */
  | "ends"
  /**
   * A response policy weighs an answer: the step that takes it goes on, its interaction still
   * open, and the next step settles it, accepted or refused.
   */
  | "policies";

export interface Bounds {
  /** What the world sends that's new: messages, controls, and more answers than one. */
  readonly sends: number;
  readonly steps: number;
  /** Requests and sign-in attempts, in all. */
  readonly asks: number;
  readonly calls: number;
  readonly tasks: number;
  /** Whether something may arrive while a step runs. */
  readonly duringStep: boolean;
  readonly features: readonly Feature[];
}

/** What the session's durable state says, as far as the scheduler reads it. */
interface Durable {
  readonly deliveries: Readonly<Record<string, "admitted" | "consumed" | "settled">>;
  readonly openTurn?: string;
  readonly turns: number;
  readonly principal: string;
  /** `weighing`: answered, and a response policy decides it in the turn's next step. */
  readonly interactions: Readonly<Record<string, "open" | "weighing" | "closed">>;
  readonly attempts: Readonly<Record<string, "open" | "called-back" | "closed">>;
  readonly calls: Readonly<
    Record<string, { readonly kind: "lookup" | "execute"; readonly status: CallStatus }>
  >;
  readonly tasks: Readonly<Record<string, "working" | "result" | "read" | "cancelled">>;
  readonly budget?: string;
  /** How often the open turn's caller heard how it ended. */
  readonly told: number;
  /** How many steps the scheduler's turn ran. */
  readonly stepsInTurn: number;
  /** Every delivery and control the world sent, by id. */
  readonly sent: readonly string[];
  /** No turn ran yet. */
  readonly prewarmed: boolean;
  /** Every delivery the session routed to its children, by id. */
  readonly routed: readonly string[];
  /** A step ended the session, so nothing may follow `session.ended`. */
  readonly ended?: true;
}

type CallStatus = "created" | "running" | "reported" | "read";

interface World {
  readonly scheduler: Scheduler;
  readonly durable: Durable;
  /** What the scheduler asks of the world, which the world answers by branching. */
  readonly asks: Next;
  readonly sent: number;
  readonly steps: number;
  readonly minted: number;
  readonly trail: readonly string[];
}

export interface Finding {
  readonly finding: string;
  readonly trail: readonly string[];
}

const NOTHING_DURABLE: Durable = {
  attempts: {},
  calls: {},
  deliveries: {},
  interactions: {},
  prewarmed: true,
  principal: principalOf(null),
  routed: [],
  sent: [],
  stepsInTurn: 0,
  tasks: {},
  told: 0,
  turns: 0,
};

const OWNER_RUN = "run_owner";

function initialWorld(findings: Finding[]): World {
  const world: Omit<World, "asks"> = {
    durable: NOTHING_DURABLE,
    minted: 0,
    scheduler: initialScheduler({ kind: "first-message" }),
    sent: 0,
    steps: 0,
    trail: [],
  };
  return settle(world, findings);
}

/** What the scheduler reads of the world's durable state. */
function reading(durable: Durable): SessionReading {
  return {
    canAskPeople: true,
    principal: durable.principal,
    inboxPending: false,
    now: 0,
    view: viewOf(durable),
    recordedRuns: new Map(
      Object.entries(durable.calls).flatMap(([callId, call]) =>
        call.kind === "execute" ? [[callId, ref(callId).toolName] as const] : [],
      ),
    ),
    tasks: {
      settled: Object.entries(durable.tasks).flatMap(([id, status]) =>
        status === "result" ? [{ id, status: "completed" as const }] : [],
      ),
      working: Object.keys(durable.tasks).filter((id) => durable.tasks[id] === "working"),
    },
    turnId: durable.openTurn ?? `turn_${durable.turns}`,
  };
}

/** Only the public fields the scheduler reads belong to this bounded world's model. */
function viewOf(durable: Durable): SessionView {
  const empty = emptySessionView();
  return {
    ...empty,
    deliveries: Object.fromEntries(
      Object.entries(durable.deliveries).map(([deliveryId, status]) => [
        deliveryId,
        { deliveryId, status } as DeliveryRow,
      ]),
    ),
    interactions:
      durable.budget === undefined
        ? {}
        : {
            [durable.budget]: {
              interactionId: durable.budget,
              introducedAt: 0,
              request: { kind: "budget" },
              status: "open",
            } as InteractionRow,
          },
    session: {
      ...empty.session,
      status: durable.prewarmed ? "new" : "open",
      ...(durable.openTurn !== undefined && { latestTurnId: durable.openTurn }),
    },
    turns:
      durable.openTurn === undefined
        ? {}
        : {
            [durable.openTurn]: { status: "running", turnId: durable.openTurn } as TurnRow,
          },
  };
}

/**
 * Runs the scheduler until it asks for something the world answers by branching, doing
 * everything else it asks on the way, and checking what holds at each request.
 */
function settle(world: Omit<World, "asks">, findings: Finding[], event?: SchedulerEvent): World {
  let current = world;
  try {
    if (event !== undefined) current = { ...current, scheduler: on(current.scheduler, event) };
    for (let asked = 0; asked < 200; asked += 1) {
      const decision = next(current.scheduler, reading(current.durable));
      const asks = decision.asks;
      current = { ...current, scheduler: decision.state };
      checkAsks({ ...current, asks }, findings);
      // Closing the turn's signals writes nothing.
      if (current.durable.ended === true && asks.kind !== "end" && asks.kind !== "end-turn")
        findings.push({ finding: `${asks.kind} follows session.ended`, trail: current.trail });
      const done = perform(current, asks);
      if (done === undefined) return { ...current, asks };
      current = done.world;
      if (done.event !== undefined)
        current = { ...current, scheduler: on(current.scheduler, done.event) };
    }
    findings.push({ finding: "the scheduler never asks the world", trail: current.trail });
  } catch (error) {
    findings.push({
      finding: `the scheduler throws: ${error instanceof Error ? error.message : String(error)}`,
      trail: current.trail,
    });
  }
  return { ...current, asks: { end: { kind: "expired" }, kind: "end" } };
}

/** What the world does at once; `undefined` for what it answers by branching. */
function perform(
  world: Omit<World, "asks">,
  asks: Next,
): { readonly world: Omit<World, "asks">; readonly event?: SchedulerEvent } | undefined {
  const durable = world.durable;
  const changed = (change: Partial<Durable>) => ({
    world: { ...world, durable: { ...durable, ...change } },
  });
  switch (asks.kind) {
    case "turn-started":
      return changed({ prewarmed: false, stepsInTurn: 0, told: 0 });
    case "start-task-calls": {
      const answers: { result: RuntimeActionResult; at: number }[] = [];
      let tasks = durable.tasks;
      for (const call of asks.calls) {
        if (call.kind !== TASK_CANCEL_TOOL_NAME) continue;
        const working = tasks[call.taskId] === "working";
        if (working) tasks = { ...tasks, [call.taskId]: "cancelled" };
        answers.push({
          at: 0,
          result: {
            callId: call.callId,
            kind: "tool-result",
            output: { status: working ? "cancelled" : "already_finished" },
            toolName: TASK_CANCEL_TOOL_NAME,
          },
        });
      }
      return {
        event: { answers, kind: "task-calls-started", startedAtMs: 0 },
        world: { ...world, durable: { ...durable, tasks } },
      };
    }
    case "interrupt-runs":
    case "report-dropped":
      return { world };
    case "admit-held": {
      const ids = [
        ...asks.deliveries.flatMap((delivery) => idsOf(delivery)),
        ...asks.controls.map(({ delivery }) => delivery.deliveryId),
      ];
      return changed({ deliveries: admit(durable.deliveries, ids) });
    }
    case "settle-control":
      return changed({
        deliveries: { ...durable.deliveries, [asks.settlement.control.deliveryId]: "settled" },
      });
    case "end-turn":
      return { world };
    case "cancel-tasks":
      return { world: { ...world, durable: cancelTasks(durable) } };
    case "settle-cancelled-turn": {
      const settled = endTurn(durable);
      const deliveries =
        asks.control === undefined
          ? settled.deliveries
          : { ...settled.deliveries, [asks.control.deliveryId]: "settled" as const };
      return {
        world: {
          ...world,
          durable: { ...settled, deliveries, told: settled.told + (asks.caller ? 1 : 0) },
        },
      };
    }
    case "notify-parked":
      return changed({ told: durable.told + 1 });
    case "dispatch": {
      let calls = durable.calls;
      const results: RuntimeActionResult[] = [];
      for (const [callId, call] of Object.entries(calls)) {
        if (call.status !== "created") continue;
        if (call.kind === "lookup") {
          calls = { ...calls, [callId]: { ...call, status: "reported" } };
          results.push(toolResult(callId));
        } else calls = { ...calls, [callId]: { ...call, status: "running" } };
      }
      return {
        event: { at: 0, kind: "dispatched", results },
        world: { ...world, durable: { ...durable, calls } },
      };
    }
    case "handle-run-message": {
      const { message } = asks;
      const call = durable.calls[message.from.callId];
      if (message.kind !== "outcome" || call?.status !== "running")
        return { event: { at: 0, kind: "handled", message }, world };
      return {
        event: { at: 0, kind: "handled", message, result: toolResult(message.from.callId) },
        world: {
          ...world,
          durable: {
            ...durable,
            calls: { ...durable.calls, [message.from.callId]: { ...call, status: "reported" } },
          },
        },
      };
    }
    case "check-session-timeout":
    case "step":
    case "wait":
    case "route":
    case "map-answers":
    case "apply-run-messages":
    case "take-turn":
    case "hand-off":
    case "fail":
    case "end":
      return undefined;
  }
}

/** Every way the world answers what the scheduler asks of `world`. */
function successors(world: World, bounds: Bounds, findings: Finding[]): readonly World[] {
  const has = (feature: Feature) => bounds.features.includes(feature);
  const go = (label: string, durable: Durable, event?: SchedulerEvent, change?: Partial<World>) =>
    settle({ ...world, ...change, durable, trail: [...world.trail, label] }, findings, event);
  const { asks, durable } = world;
  switch (asks.kind) {
    case "end":
    case "fail":
      return [];
    case "check-session-timeout": {
      const fresh = go("idle timeout: fresh", durable, {
        kind: "session-timeout-checked",
        expired: false,
      });
      return has("controls")
        ? [
            fresh,
            go("idle timeout: expired", durable, {
              kind: "session-timeout-checked",
              expired: true,
            }),
          ]
        : [fresh];
    }
    case "route": {
      const offered: Durable = {
        ...durable,
        routed: [...new Set([...durable.routed, ...idsOf(asks.delivery)])],
      };
      const keeps = go(
        "routed: kept",
        offered,
        routed({ delivery: asks.delivery, kind: "remainder" }),
      );
      // A child takes only what answers its own question.
      const answersChild = asks.delivery.payloads.some((payload) =>
        (payload.answers ?? []).some((answer) => answer.interactionId === "child_request"),
      );
      if (!has("children") || !answersChild) return [keeps];
      return [
        keeps,
        go(
          "routed: a child took it",
          consume(offered, idsOf(asks.delivery), "settled"),
          routed({ kind: "consumed" }),
        ),
        // A hook on what a child took cancels the turn: the child took it first.
        go(
          "routed: a child takes it, and a hook stops the turn",
          consume(offered, idsOf(asks.delivery), "settled"),
          routed({ kind: "cancel-turn" }),
        ),
      ];
    }
    case "map-answers": {
      const none = go("mapped: nothing", durable, { kind: "mapped" });
      if (!has("children")) return [none];
      const answers = asks.requestIds.map((interactionId) => ({
        interactionId,
        optionId: "approve",
      }));
      const delivery = { ...asks.delivery, payloads: [{ answers }] };
      return [none, go("mapped onto the request", durable, { delivery, kind: "mapped" })];
    }
    case "apply-run-messages": {
      const applied = applyMessages(durable, asks.messages);
      const keeps = go("applied", applied, { cancelled: false, kind: "applied" });
      if (!asks.canCancelTurn || !has("children")) return [keeps];
      return [keeps, go("applied: a hook cancels", applied, { cancelled: true, kind: "applied" })];
    }
    case "take-turn":
    case "hand-off": {
      const stays = go("stays", durable, { kind: "transfer", transferred: false });
      const may =
        has("handoff") &&
        (asks.kind === "hand-off" || asks.selection.handoffEligible || asks.compactionDue);
      return may ? [stays, go("moves", durable, { kind: "transfer", transferred: true })] : [stays];
    }
    case "wait":
      return waitMoves(world, bounds, go);
    case "step":
      return stepMoves(world, asks, bounds, findings);
    default:
      throw new Error(`The checker branches on nothing for ${asks.kind}.`);
  }
}

type Go = (
  label: string,
  durable: Durable,
  event?: SchedulerEvent,
  change?: Partial<World>,
) => World;

/** What the world sends, or what resolves, while the session waits. */
function waitMoves(world: World, bounds: Bounds, go: Go): World[] {
  const moves: World[] = [];
  if (world.asks.kind !== "wait") return moves;
  if (world.asks.timeout !== undefined) {
    const { callId } = world.asks.timeout;
    moves.push(go(`timer ${callId}`, world.durable, { callId, kind: "timed-out" }));
  }
  for (const { label, payload, costs } of payloads(world, bounds)) {
    const { durable, minted } = sending(world, payload);
    const arrivals = arrivalsOf(payload, OWNER_RUN);
    moves.push(
      go(
        label,
        durable,
        { arrivals, kind: "arrived" },
        {
          minted,
          sent: world.sent + (costs ? 1 : 0),
        },
      ),
    );
  }
  return moves;
}

/** Every result a step may return, and what may arrive while it runs. */
function stepMoves(
  world: World,
  asks: Extract<Next, { readonly kind: "step" }>,
  bounds: Bounds,
  findings: Finding[],
): World[] {
  const has = (feature: Feature) => bounds.features.includes(feature);
  // A policy settles what the last step left weighing, accepted or refused.
  const weighing = Object.keys(world.durable.interactions).filter(
    (id) => world.durable.interactions[id] === "weighing",
  );
  const settled = (outcome: "open" | "closed"): Durable => ({
    ...world.durable,
    interactions: {
      ...world.durable.interactions,
      ...Object.fromEntries(weighing.map((id) => [id, outcome])),
    },
  });
  // A refusal asks again, which another answer may meet: it costs a send, so every path ends.
  const refusal: Taking[] =
    world.sent < bounds.sends
      ? [{ costs: true, durable: takeInput(settled("open"), asks), label: "a policy refuses, " }]
      : [];
  const takings: Taking[] =
    weighing.length === 0
      ? [{ durable: takeInput(world.durable, asks), label: "" }]
      : [{ durable: takeInput(settled("closed"), asks), label: "a policy accepts, " }, ...refusal];
  // Someone other than the turn's own person may not be allowed to answer: the step refuses
  // their answers, which leave what they answered open, and settles their delivery.
  const delivery = asks.input?.delivery;
  const turn = turnOf(world.scheduler);
  const others =
    delivery?.auth !== undefined &&
    turn !== undefined &&
    principalOf(delivery.auth) !== turn.steerer.principal
      ? delivery.payloads.flatMap((payload) => payload.answers ?? [])
      : [];
  const refusable = others
    .map((answer) => answer.interactionId)
    .filter((id) => world.durable.interactions[id] === "open");
  // It asks again, which another answer may meet: it costs a send, so every path ends.
  if (refusable.length > 0 && weighing.length === 0 && world.sent < bounds.sends) {
    const refused = takeInput(world.durable, asks);
    takings.push({
      durable: {
        ...refused,
        deliveries: {
          ...refused.deliveries,
          ...Object.fromEntries(idsOf(delivery!).map((id) => [id, "settled" as const])),
        },
        interactions: {
          ...refused.interactions,
          ...Object.fromEntries(refusable.map((id) => [id, "open" as const])),
        },
      },
      costs: true,
      label: "refuses the answer, ",
    });
  }
  const answers = (asks.input?.delivery?.payloads ?? []).flatMap((payload) =>
    payload.message === undefined ? (payload.answers ?? []) : [],
  );
  const weighed = answers
    .map((answer) => answer.interactionId)
    .filter((id) => world.durable.interactions[id] === "open");
  if (has("policies") && weighing.length === 0 && weighed.length > 0 && answers.length > 0)
    takings.push({
      durable: takeInput(
        {
          ...world.durable,
          interactions: {
            ...world.durable.interactions,
            ...Object.fromEntries(weighed.map((id) => [id, "weighing" as const])),
          },
        },
        asks,
      ),
      label: "a policy weighs it, ",
      weighs: true,
    });
  const out: World[] = [];
  for (const taking of takings) out.push(...stepMovesTaking(world, asks, bounds, findings, taking));
  return out;
}

/** What a step takes, as a policy may settle or weigh its answers. */
interface Taking {
  readonly label: string;
  readonly durable: Durable;
  /** A policy weighs the step's answers: the step goes on. */
  readonly weighs?: true;
  /** It costs a send. */
  readonly costs?: true;
}

function stepMovesTaking(
  world: World,
  asks: Extract<Next, { readonly kind: "step" }>,
  bounds: Bounds,
  findings: Finding[],
  taking: Taking,
): World[] {
  const taken = taking.durable;
  const during: ({ label: string; payload: SessionInboxPayload; costs: boolean } | undefined)[] = [
    undefined,
    ...(bounds.duringStep ? payloads({ ...world, durable: taken }, bounds) : []),
  ];
  const out: World[] = [];
  for (const arrival of during) {
    const sent = world.sent + (arrival?.costs === true ? 1 : 0) + (taking.costs === true ? 1 : 0);
    const { durable: before, minted } =
      arrival === undefined
        ? { durable: taken, minted: world.minted }
        : sending({ ...world, durable: taken }, arrival.payload);
    const turn = turnOf(world.scheduler);
    const stops =
      arrival !== undefined &&
      turn !== undefined &&
      urgency(arrival.payload, turn, { childrenAsk: false }) === "stop";
    // A step whose answer a policy weighs goes on: the policy decides in its next step.
    const results =
      taking.weighs === true
        ? [
            ...(stops
              ? [
                  {
                    durable: before,
                    end: { action: "cancelled" } as StepEnd,
                    label: "cancelled",
                    minted,
                  },
                ]
              : []),
            { durable: before, end: { action: "continue" } as StepEnd, label: "goes on", minted },
          ]
        : stepResults({ ...world, durable: before, minted }, asks, bounds, stops);
    for (const result of results) {
      const { end, durable, minted: afterMinted } = result;
      const arrivals = arrival === undefined ? [] : arrivalsOf(arrival.payload, OWNER_RUN);
      const label = `step: ${taking.label}${result.label}${arrival === undefined ? "" : `, as ${arrival.label}`}`;
      const stepped: World = settle(
        {
          ...world,
          durable: { ...durable, stepsInTurn: durable.stepsInTurn + 1 },
          minted: afterMinted,
          sent,
          steps: world.steps + 1,
          trail: [...world.trail, label],
        },
        findings,
        { arrivals, kind: "stepped", result: end },
      );
      // The pump's urgent signal and the boundary agree: what stops the step stops the turn, and
      // nothing else does. A step that ended the session anyway leaves no turn to stop.
      if (turn !== undefined && !turn.stopping && end.action !== "done") {
        const boundary = turnOf(on(world.scheduler, { arrivals, kind: "stepped", result: end }));
        if (boundary !== undefined && boundary.stopping !== stops)
          findings.push({
            finding: stops
              ? "what stopped the step doesn't stop the turn at its boundary"
              : "the boundary stops a turn nothing stopped the step of",
            trail: stepped.trail,
          });
      }
      out.push(stepped);
    }
  }
  return out;
}

/** What a step does with what it takes: onto the stream, and what it answers closes. */
function takeInput(durable: Durable, asks: Extract<Next, { readonly kind: "step" }>): Durable {
  const input = asks.input;
  let next: Durable = durable;
  if (input?.control !== undefined) return next;
  if (next.openTurn === undefined)
    next = { ...next, openTurn: `turn_${next.turns}`, turns: next.turns + 1 };
  const delivery = input?.delivery;
  if (delivery !== undefined) {
    next = consume(next, idsOf(delivery), "consumed");
    let interactions = next.interactions;
    let attempts = next.attempts;
    for (const payload of delivery.payloads) {
      for (const answer of payload.answers ?? [])
        if (interactions[answer.interactionId] === "open")
          interactions = { ...interactions, [answer.interactionId]: "closed" };
      const attemptId = attemptOf(payload);
      if (attemptId !== undefined) attempts = { ...attempts, [attemptId]: "closed" };
      // A message steers past what the turn asked: the step withdraws it.
      if (payload.message !== undefined) {
        interactions = closeAll(interactions);
        attempts = Object.fromEntries(Object.keys(attempts).map((id) => [id, "closed" as const]));
      }
    }
    if (next.budget !== undefined && interactions[next.budget] === "closed")
      next = { ...next, budget: undefined };
    next = { ...next, attempts, interactions };
    if (
      delivery.auth !== undefined &&
      delivery.payloads.some((payload) => payload.message !== undefined)
    )
      next = { ...next, principal: principalOf(delivery.auth) };
  }
  for (const result of input?.runtimeResults?.results ?? []) {
    const call = next.calls[result.callId];
    if (call !== undefined)
      next = { ...next, calls: { ...next.calls, [result.callId]: { ...call, status: "read" } } };
  }
  const tasks = Object.fromEntries(
    Object.entries(next.tasks).map(([id, status]) => [id, status === "result" ? "read" : status]),
  );
  return { ...next, tasks };
}

interface StepOutcome {
  readonly label: string;
  readonly end: StepEnd;
  readonly durable: Durable;
  readonly minted: number;
}

/** Every result a step may return, as its contract allows from what it took. */
function stepResults(
  world: World,
  asks: Extract<Next, { readonly kind: "step" }>,
  bounds: Bounds,
  stopped: boolean,
): StepOutcome[] {
  const has = (feature: Feature) => bounds.features.includes(feature);
  const { durable, minted } = world;
  const results: StepOutcome[] = [];
  const add = (label: string, end: StepEnd, after: Durable = durable, mintedAfter = minted) =>
    results.push({ durable: after, end, label, minted: mintedAfter });
  if (stopped) add("cancelled", { action: "cancelled" });
  if (asks.input?.control !== undefined) {
    const id = asks.input.controlDelivery?.deliveryId;
    const cleared =
      asks.input.control === "clear" && durable.openTurn !== undefined ? endTurn(durable) : durable;
    const settled =
      id === undefined
        ? cleared
        : { ...cleared, deliveries: { ...cleared.deliveries, [id]: "settled" as const } };
    add(asks.input.control, { action: "parked" }, settled);
    return results;
  }
  const open = Object.keys(durable.interactions).filter(
    (id) => durable.interactions[id] === "open",
  );
  const attempts = Object.keys(durable.attempts).filter((id) => durable.attempts[id] !== "closed");
  const asked = Object.keys(durable.interactions).length + Object.keys(durable.attempts).length;
  const canAsk = asked < bounds.asks;
  const last = world.steps + 1 >= bounds.steps;
  if (has("ends"))
    add(
      "ends the session",
      { action: "done", output: "Done." },
      { ...endTurn(durable), ended: true },
    );
  // A turn that asks still waits on what it asked.
  if (open.length > 0 || attempts.length > 0) {
    add("waits on what it asked", {
      action: "paused",
      attemptIds: attempts,
      on: "interaction",
      requestIds: open,
    });
    return results;
  }
  add("replies", { action: "parked", settled: { output: "Done." } }, endTurn(durable));
  if (last) return results;
  add("goes on", { action: "continue" });
  if (has("handoff")) add("compacts and goes on", { action: "continue", compacted: true });
  if (canAsk) {
    const id = `request_${minted}`;
    add(
      "asks for approval",
      { action: "paused", attemptIds: [], on: "interaction", requestIds: [id] },
      { ...durable, interactions: { ...durable.interactions, [id]: "open" } },
      minted + 1,
    );
    if (has("sign-ins")) {
      const attempt = `attempt_${minted}`;
      add(
        "asks for a sign-in",
        { action: "paused", attemptIds: [attempt], on: "interaction", requestIds: [] },
        { ...durable, attempts: { ...durable.attempts, [attempt]: "open" } },
        minted + 1,
      );
      if (asked + 2 <= bounds.asks) {
        const second = `attempt_${minted}b`;
        add(
          "asks for two sign-ins",
          { action: "paused", attemptIds: [attempt, second], on: "interaction", requestIds: [] },
          { ...durable, attempts: { ...durable.attempts, [attempt]: "open", [second]: "open" } },
          minted + 1,
        );
      }
    }
    if (has("budget")) {
      const id = `budget_${minted}`;
      add(
        "parks on a budget prompt",
        { action: "parked" },
        { ...durable, budget: id, interactions: { ...durable.interactions, [id]: "open" } },
        minted + 1,
      );
    }
  }
  const calls = Object.keys(durable.calls).length;
  if (calls < bounds.calls) {
    for (const kind of ["lookup", "execute"] as const) {
      const callId = `call_${minted}`;
      add(
        `calls ${kind}`,
        { action: "paused", callIds: [callId], dispatch: true, on: "calls", taskToolCalls: [] },
        { ...durable, calls: { ...durable.calls, [callId]: { kind, status: "created" } } },
        minted + 1,
      );
    }
  }
  if (has("tasks")) {
    const tasks = Object.keys(durable.tasks);
    const working = tasks.filter((id) => durable.tasks[id] === "working");
    if (tasks.length < bounds.tasks) {
      const taskId = `task_${minted}`;
      add(
        "starts a task and goes on",
        { action: "continue" },
        { ...durable, tasks: { ...durable.tasks, [taskId]: "working" } },
        minted + 1,
      );
    }
    if (working.length > 0)
      add("waits on its tasks", { action: "paused", on: "tasks", taskIds: working });
    if (tasks.length > 0 && calls < bounds.calls) {
      const callId = `call_${minted}`;
      const taskCall = (call: TaskToolCall, label: string) =>
        add(
          label,
          {
            action: "paused",
            callIds: [callId],
            dispatch: false,
            on: "calls",
            taskToolCalls: [call],
          },
          durable,
          minted + 1,
        );
      taskCall({ callId, kind: TASK_WAIT_TOOL_NAME }, "calls eve__task_wait");
      taskCall(
        { callId, kind: TASK_WAIT_TOOL_NAME, timeoutMs: 1000 },
        "calls eve__task_wait with a timeout",
      );
      taskCall(
        { callId, kind: TASK_WAIT_TOOL_NAME, timeoutMs: 0 },
        "calls eve__task_wait without waiting",
      );
      if (working.length > 0)
        taskCall(
          { callId, kind: TASK_CANCEL_TOOL_NAME, taskId: working[0]! },
          "calls eve__task_cancel",
        );
    }
  }
  return results;
}

/** What the world may send now, and whether it costs a send. */
function payloads(
  world: World,
  bounds: Bounds,
): { readonly label: string; readonly payload: SessionInboxPayload; readonly costs: boolean }[] {
  const has = (feature: Feature) => bounds.features.includes(feature);
  const { durable } = world;
  const out: { label: string; payload: SessionInboxPayload; costs: boolean }[] = [];
  const id = (kind: string) => `${kind}_${world.minted}`;
  const held = new Set(
    heldDeliveries(world.scheduler.held).flatMap((delivery) =>
      delivery.payloads.flatMap((payload) => [
        ...(payload.answers ?? []).map((answer) => answer.interactionId),
        ...(attemptOf(payload) === undefined ? [] : [attemptOf(payload)!]),
      ]),
    ),
  );
  // What resolves something open: the owner answers, a callback comes, a run reports.
  for (const interactionId of Object.keys(durable.interactions)) {
    if (durable.interactions[interactionId] !== "open" || held.has(interactionId)) continue;
    out.push({
      costs: false,
      label: `Alice answers ${interactionId}`,
      payload: deliver(id("delivery"), ALICE, [
        { answers: [{ interactionId, optionId: "approve" }] },
      ]),
    });
  }
  for (const attemptId of Object.keys(durable.attempts)) {
    if (durable.attempts[attemptId] !== "open") continue;
    out.push({
      costs: false,
      label: `the sign-in ${attemptId} calls back`,
      payload: {
        kind: "authorization-callback",
        payloads: [
          {
            authorizationCallback: {
              attemptId,
              callback: { method: "GET", params: {} },
              connectionName: "linear",
            },
          },
        ],
      },
    });
  }
  for (const [callId, call] of Object.entries(durable.calls)) {
    if (call.status !== "running") continue;
    out.push({
      costs: false,
      label: `${callId} finishes`,
      payload: {
        from: ref(callId),
        kind: "outcome",
        result: { output: "built", status: "completed" },
      },
    });
  }
  for (const [taskId, status] of Object.entries(durable.tasks)) {
    if (status !== "working") continue;
    out.push({
      costs: false,
      label: `${taskId} finishes`,
      payload: {
        from: ref(`${taskId}_call`, taskId),
        kind: "outcome",
        result: { output: "found", status: "completed" },
      },
    });
  }
  if (world.sent >= bounds.sends) return out;
  // Anything new.
  const message = (from: SessionAuthContext, extra: Partial<DeliverHookPayload> = {}) =>
    deliver(id("delivery"), from, [{ message: `A note from ${from.principalId}` }], extra);
  out.push({ costs: true, label: "Alice writes", payload: message(ALICE) });
  out.push({ costs: true, label: "Bob writes", payload: message(BOB) });
  for (const interactionId of Object.keys(durable.interactions)) {
    if (durable.interactions[interactionId] !== "open") continue;
    out.push({
      costs: true,
      label: `Bob answers ${interactionId}, with a note`,
      payload: deliver(id("delivery"), BOB, [
        { answers: [{ interactionId, optionId: "approve" }], message: "A note from bob" },
      ]),
    });
  }
  if (has("queue"))
    out.push({
      costs: true,
      label: "Alice queues a message",
      payload: message(ALICE, { turnPolicy: "queue" }),
    });
  if (has("delegated"))
    out.push({
      costs: true,
      label: "Alice writes through her agent",
      payload: message(ALICE, {
        caller: {
          callId: "parent_call",
          replyTo: { kind: "hook", token: "parent" },
          subagentName: "helper",
        },
      }),
    });
  if (has("sign-ins"))
    for (const attemptId of Object.keys(durable.attempts))
      out.push({
        costs: true,
        label: `the sign-in ${attemptId} calls back again`,
        payload: {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId,
                callback: { method: "GET", params: {} },
                connectionName: "linear",
              },
            },
          ],
        },
      });
  if (has("tasks"))
    for (const [taskId, status] of Object.entries(durable.tasks))
      if (status === "working")
        out.push({
          costs: true,
          label: `${taskId} reports`,
          payload: { from: ref(`${taskId}_call`, taskId), kind: "report", update: "Halfway." },
        });
  if (has("children")) {
    // An answer to a question this session doesn't know: a child's, or one its channel maps.
    out.push({
      costs: true,
      label: "Alice answers a child's question",
      payload: deliver(id("delivery"), ALICE, [
        { answers: [{ interactionId: "child_request", optionId: "approve" }] },
      ]),
    });
    const callId = Object.keys(durable.calls).find(
      (call) => durable.calls[call]?.status === "running",
    );
    if (callId !== undefined)
      out.push({
        costs: true,
        label: `${callId} opens a child`,
        payload: {
          from: ref(callId),
          kind: "agent-started",
          context: {
            agents: {},
            bundle: { source: { kind: "development" } },
            dynamicSelections: {},
            parent: {
              callId,
              rootSessionId: "owner",
              sessionId: "owner",
              turn: { id: "turn_0", sequence: 0 },
            },
            sandbox: { sessionId: "owner" },
            trace: { originAudience: "unknown" },
          },
          session: {
            continuationToken: "subagent:child",
            kind: "local",
            name: "child",
            nodeId: "child",
            sessionId: "child",
          },
        },
      });
  }
  if (has("controls")) {
    const auth = ALICE;
    out.push({
      costs: true,
      label: "Alice cancels",
      payload: { auth, deliveryId: id("cancel"), kind: "cancel" },
    });
    if (durable.openTurn !== undefined)
      out.push({
        costs: true,
        label: "Alice cancels the open turn",
        payload: { auth, deliveryId: id("cancel"), kind: "cancel", turnId: durable.openTurn },
      });
    out.push({
      costs: true,
      label: "Alice cancels a turn that ended",
      payload: { auth, deliveryId: id("cancel"), kind: "cancel", turnId: "turn_gone" },
    });
    out.push({
      costs: true,
      label: "Alice resets",
      payload: { auth, deliveryId: id("reset"), kind: "reset" },
    });
    out.push({
      costs: true,
      label: "Alice clears",
      payload: { auth, deliveryId: id("clear"), kind: "clear" },
    });
    out.push({
      costs: true,
      label: "Alice compacts",
      payload: { auth, deliveryId: id("compact"), kind: "compact" },
    });
    out.push({
      costs: true,
      label: "the session times out",
      payload: { kind: "session-timeout", ownerRunId: OWNER_RUN },
    });
    // A control needs a delivery id: the session can't read one without, and reports it.
    out.push({
      costs: true,
      label: "an unreadable payload",
      payload: { deliveryId: "", kind: "cancel" },
    });
  }
  return out;
}

/** The delivery or control a payload is, if it's either. */
function sentId(payload: SessionInboxPayload): string | undefined {
  if (payload.kind === "deliver") return idsOf(payload)[0];
  if (!("deliveryId" in payload) || typeof payload.deliveryId !== "string") return undefined;
  return payload.deliveryId === "" ? undefined : payload.deliveryId;
}

/** The world sends `payload`: its ids are minted. */
function sending(
  world: World,
  payload: SessionInboxPayload,
): { readonly durable: Durable; readonly minted: number } {
  let durable = world.durable;
  const id = sentId(payload);
  // Open: a prewarmed session drops a clear or compact that comes before its first message, and
  // nothing settles it. This PR leaves that decision open, so the checker leaves those out.
  const dropped = durable.prewarmed && (payload.kind === "clear" || payload.kind === "compact");
  if (id !== undefined && !dropped) durable = { ...durable, sent: [...durable.sent, id] };
  if (payload.kind === "authorization-callback")
    for (const entry of payload.payloads) {
      const attemptId = attemptOf(entry);
      if (attemptId !== undefined && durable.attempts[attemptId] === "open")
        durable = { ...durable, attempts: { ...durable.attempts, [attemptId]: "called-back" } };
    }
  return { durable, minted: world.minted + 1 };
}

// ---------------------------------------------------------------------------------------------
// What holds
// ---------------------------------------------------------------------------------------------

/** What holds whenever the scheduler asks the world for something. */
function checkAsks(world: World, findings: Finding[]): void {
  const fail = (finding: string): void => {
    findings.push({ finding, trail: world.trail });
  };
  const { asks, durable, scheduler } = world;
  const heldIds = heldDeliveries(scheduler.held).flatMap(idsOf);
  // `heldOnce`, `heldNeverEnded`.
  if (new Set(heldIds).size !== heldIds.length) fail("the session holds a delivery twice");
  for (const id of heldIds)
    if (durable.deliveries[id] === "settled") fail(`the session holds ${id}, which ended`);
  const turn = turnOf(scheduler);
  switch (asks.kind) {
    case "step": {
      const ids = asks.input?.delivery === undefined ? [] : idsOf(asks.input.delivery);
      // `takesOnlyWhatItLetsGo`.
      for (const id of ids)
        if (heldIds.includes(id)) fail(`a step takes ${id}, which the session still holds`);
      // A child's answer reaches a step only once the session offered it to the child.
      const forChild = (asks.input?.delivery?.payloads ?? []).some((payload) =>
        (payload.answers ?? []).some((answer) => answer.interactionId === "child_request"),
      );
      if (forChild && ids.some((id) => !durable.routed.includes(id)))
        fail(`a step takes a child's answer (${ids.join(",")}) the session never routed`);
      // `onlyItsPersonSteers`: once a turn runs, anyone else brings it only answers.
      if (turn !== undefined && durable.stepsInTurn > 0 && asks.input?.delivery !== undefined) {
        const { delivery } = asks.input;
        const writes = delivery.payloads.some((payload) => payload.message !== undefined);
        if (
          writes &&
          delivery.auth !== undefined &&
          principalOf(delivery.auth) !== turn.steerer.principal
        )
          fail(`${delivery.auth?.principalId} steers someone else's turn`);
      }
      // A turn resumes on its sign-ins once every one called back.
      const callbacks = (asks.input?.delivery?.payloads ?? []).flatMap(
        (payload) => attemptOf(payload) ?? [],
      );
      for (const attemptId of Object.keys(durable.attempts))
        if (callbacks.length > 0 && durable.attempts[attemptId] === "open")
          fail(`a turn resumes on sign-ins while ${attemptId} hasn't called back`);
      if (new Set(callbacks).size !== callbacks.length)
        fail("a step takes a sign-in's callback twice");
      return;
    }
    case "wait": {
      // `waitingShowsHeld`.
      for (const id of heldIds)
        if (durable.deliveries[id] === undefined)
          fail(`the session waits while ${id} is off the stream`);
      for (const entry of scheduler.held.entries)
        if (
          entry.kind === "control" &&
          entry.origin !== undefined &&
          durable.deliveries[entry.origin.deliveryId] === undefined
        )
          fail(`the session waits while the control ${entry.origin.deliveryId} is off the stream`);
      const at = turn?.at;
      if (turn === undefined) {
        // `idleLeavesNothingOpen`: a budget prompt alone holds a turn open between turns.
        if (durable.budget === undefined) {
          if (durable.openTurn !== undefined)
            fail("the session waits between turns with a turn open");
          // `idleLeavesNothingOpen`, `cancelsSettle`: everything the world sent has settled.
          for (const id of durable.sent)
            if (
              durable.deliveries[id] !== "settled" &&
              !(
                durable.prewarmed &&
                scheduler.unstarted?.some(({ control }) => control.deliveryId === id)
              )
            )
              fail(
                `the session waits between turns with ${id} ${durable.deliveries[id] ?? "off the stream"}`,
              );
        }
        return;
      }
      if (at?.kind !== "waiting") return fail(`a turn waits on the inbox at ${at?.kind}`);
      const { wait } = at;
      // `sleepsOnNothing`, `waitsOnOpen`.
      if (wait.on === "interaction") {
        for (const id of wait.requestIds)
          if (durable.interactions[id] !== "open") fail(`a turn waits on ${id}, which closed`);
        const calledBack = wait.attemptIds.filter((id) => durable.attempts[id] === "called-back");
        if (wait.attemptIds.length > 0 && calledBack.length === wait.attemptIds.length)
          fail("a turn sleeps on sign-ins that all called back");
        for (const sequence of turn.admitted) {
          const entry = scheduler.held.entries.find((held) => held.sequence === sequence);
          if (entry?.kind !== "delivery") continue;
          const answers = entry.delivery.payloads.flatMap((payload) => payload.answers ?? []);
          if (answers.some((answer) => wait.requestIds.includes(answer.interactionId)))
            fail(`a turn sleeps on an answer it holds (${idsOf(entry.delivery).join(",")})`);
          // The turn's own person steers past what it asked, with any message sent after it
          // asked, or with one that steers.
          const { delivery } = entry;
          const own =
            delivery.caller === undefined && principalOf(delivery.auth) === turn.steerer.principal;
          const steers = (delivery.turnPolicy ?? "steer") === "steer" || sequence >= wait.heldSince;
          if (own && steers && delivery.payloads.some((payload) => payload.message !== undefined))
            fail(`a turn sleeps on its own person's message (${idsOf(delivery).join(",")})`);
        }
      }
      if (wait.on === "calls") {
        if (wait.dispatch) fail("a turn sleeps on calls it didn't start");
        const reported = new Set(wait.results.map((result) => result.callId));
        if (wait.callIds.every((callId) => reported.has(callId)))
          fail("a turn sleeps on calls that all reported");
        const timeout = asks.timeout;
        if (
          timeout !== undefined &&
          !wait.taskWaits.some(
            (taskWait) =>
              taskWait.callId === timeout.callId && taskWait.deadlineMs === timeout.deadlineMs,
          )
        )
          fail(`a turn waits on a deadline which no task wait has`);
      }
      if (
        wait.on === "tasks" &&
        (wait.interrupted ||
          Object.values(durable.tasks).includes("result") ||
          !Object.values(durable.tasks).includes("working"))
      )
        fail("a turn sleeps on tasks that settled");
      // `cancelsSettle`: a turn that waits has taken every cancel it read.
      if (turn.stopping) fail("a stopped turn waits");
      return;
    }
    case "notify-parked":
    case "settle-cancelled-turn":
      // A delegated caller hears once how its turn ended.
      if (durable.told > 0 && (asks.kind === "notify-parked" || asks.caller !== undefined))
        fail("a delegated caller hears twice how its turn ended");
      return;
    case "end":
    case "fail":
      if (asks.kind === "fail") fail(`the session fails: ${asks.message}`);
      return;
    default:
      return;
  }
}

/** A session that waits between turns on nothing, or ended: the world has nothing it owes. */
function quiet(world: World): boolean {
  if (world.asks.kind === "end" || world.asks.kind === "fail") return true;
  return (
    world.asks.kind === "wait" &&
    turnOf(world.scheduler) === undefined &&
    world.durable.budget === undefined
  );
}

// ---------------------------------------------------------------------------------------------
// The world's durable state
// ---------------------------------------------------------------------------------------------

function idsOf(delivery: DeliverHookPayload): string[] {
  return (delivery.deliveryMetadata ?? []).map((entry) => entry.deliveryId);
}

function attemptOf(payload: DeliverPayload): string | undefined {
  const callback = payload["authorizationCallback"] as { readonly attemptId?: unknown } | undefined;
  return typeof callback?.attemptId === "string" ? callback.attemptId : undefined;
}

function admit(deliveries: Durable["deliveries"], ids: readonly string[]): Durable["deliveries"] {
  return ids.reduce(
    (current, id) =>
      current[id] === undefined ? { ...current, [id]: "admitted" as const } : current,
    deliveries,
  );
}

function consume(
  durable: Durable,
  ids: readonly string[],
  status: "consumed" | "settled",
): Durable {
  return {
    ...durable,
    deliveries: ids.reduce(
      (current, id) => (current[id] === "settled" ? current : { ...current, [id]: status }),
      durable.deliveries,
    ),
  };
}

function closeAll(interactions: Durable["interactions"]): Durable["interactions"] {
  return Object.fromEntries(Object.keys(interactions).map((id) => [id, "closed" as const]));
}

/** The turn ends: everything it took settles, and everything it asked closes. */
function endTurn(durable: Durable): Durable {
  const { budget: _budget, openTurn: _turn, ...rest } = durable;
  return {
    ...rest,
    attempts: Object.fromEntries(
      Object.keys(durable.attempts).map((id) => [id, "closed" as const]),
    ),
    deliveries: Object.fromEntries(
      Object.entries(durable.deliveries).map(([id, status]) => [
        id,
        status === "consumed" ? "settled" : status,
      ]),
    ),
    interactions: closeAll(durable.interactions),
  };
}

function cancelTasks(durable: Durable): Durable {
  return {
    ...durable,
    tasks: Object.fromEntries(
      Object.entries(durable.tasks).map(([id, status]) => [
        id,
        status === "working" ? "cancelled" : status,
      ]),
    ),
  };
}

function applyMessages(durable: Durable, messages: readonly WorkflowToolRunMessage[]): Durable {
  let tasks = durable.tasks;
  for (const message of messages) {
    const taskId = message.from.taskId;
    if (taskId !== undefined && message.kind === "outcome" && tasks[taskId] === "working")
      tasks = { ...tasks, [taskId]: "result" };
  }
  return { ...durable, tasks };
}

function routed(
  routed: Extract<SchedulerEvent, { readonly kind: "routed" }>["routed"],
): SchedulerEvent {
  return { kind: "routed", routed };
}

function deliver(
  deliveryId: string,
  auth: SessionAuthContext,
  payloads: DeliverPayload[],
  extra: Partial<DeliverHookPayload> = {},
): DeliverHookPayload {
  return {
    auth,
    deliveryMetadata: payloads.map((_payload, payloadIndex) => ({
      channelKind: "http",
      channelName: "test",
      deliveryId,
      payloadIndex,
    })),
    kind: "deliver",
    payloads,
    ...extra,
  };
}

function ref(callId: string, taskId?: string) {
  return {
    callId,
    input: {},
    runId: `run_${callId}`,
    sequence: 0,
    stepIndex: 0,
    toolName: taskId === undefined ? "build" : "research",
    turnId: "turn_0",
    ...(taskId !== undefined && { taskId }),
  };
}

function toolResult(callId: string): RuntimeActionResult {
  return { callId, kind: "tool-result", output: { done: true }, toolName: "build" };
}

// ---------------------------------------------------------------------------------------------
// Exploring
// ---------------------------------------------------------------------------------------------

/** A key that's equal exactly for equal worlds, whatever order their objects were built in. */
function keyOf(world: World): string {
  return canonical({
    asks: world.asks,
    durable: world.durable,
    minted: world.minted,
    scheduler: world.scheduler,
    sent: world.sent,
    steps: world.steps,
  });
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

export interface Explored {
  readonly states: number;
  readonly edges: number;
  readonly quiet: number;
  readonly findings: readonly Finding[];
  /** How many states took each kind of request: what the bound reached. */
  readonly coverage: ReadonlyMap<string, number>;
  /**
   * With `observe`, what the world saw wherever it moves (a step, a wait, the end, a failure), as
   * its durable state with what the scheduler asks of it, hashed, each with the shortest trail
   * that reaches it. Two schedulers that behave alike observe the same, whatever state each keeps:
   * `pnpm spec:scheduler-compare` compares two.
   */
  readonly observed?: ReadonlyMap<string, string>;
}

/**
 * Every state the scheduler reaches within `bounds`, breadth first, with what holds checked in
 * each, and every state checked to reach quiet: a session never gets stuck where the world can
 * still act.
 */
export function explore(bounds: Bounds, options: { readonly observe?: boolean } = {}): Explored {
  const findings: Finding[] = [];
  const observed = new Map<string, string>();
  const first = initialWorld(findings);
  const index = new Map<string, number>([[keyOf(first), 0]]);
  const worlds: World[] = [first];
  const predecessors: number[][] = [[]];
  const coverage = new Map<string, number>();
  let edges = 0;
  for (let at = 0; at < worlds.length; at += 1) {
    const world = worlds[at]!;
    const kind = coverageOf(world);
    coverage.set(kind, (coverage.get(kind) ?? 0) + 1);
    if (options.observe === true && ["step", "wait", "end", "fail"].includes(world.asks.kind)) {
      const seen = observationOf(world);
      if (!observed.has(seen)) observed.set(seen, world.trail.join(" | "));
    }
    for (const successor of successors(world, bounds, findings)) {
      edges += 1;
      const key = keyOf(successor);
      let to = index.get(key);
      if (to === undefined) {
        to = worlds.length;
        index.set(key, to);
        worlds.push(successor);
        predecessors.push([]);
      }
      predecessors[to]!.push(at);
    }
  }
  // Backward from quiet: every state that can't get there is stuck.
  const reaches = new Uint8Array(worlds.length);
  const queue: number[] = [];
  worlds.forEach((world, at) => {
    if (quiet(world)) {
      reaches[at] = 1;
      queue.push(at);
    }
  });
  for (let head = 0; head < queue.length; head += 1)
    for (const from of predecessors[queue[head]!]!)
      if (reaches[from] === 0) {
        reaches[from] = 1;
        queue.push(from);
      }
  const stuck = worlds.filter((_world, at) => reaches[at] === 0);
  for (const world of stuck.slice(0, 3))
    findings.push({
      finding: `the session can't get quiet from ${world.asks.kind}`,
      trail: world.trail,
    });
  if (stuck.length > 3)
    findings.push({ finding: `and ${stuck.length - 3} more states can't get quiet`, trail: [] });
  return {
    coverage,
    edges,
    findings,
    quiet: queue.length === 0 ? 0 : worlds.filter(quiet).length,
    states: worlds.length,
    ...(options.observe === true && { observed }),
  };
}

function observationOf(world: World): string {
  const { asks, durable, minted, sent, steps } = world;
  return createHash("sha256")
    .update(canonical({ asks, durable, minted, sent, steps }))
    .digest("hex")
    .slice(0, 24);
}

function coverageOf(world: World): string {
  const turn = turnOf(world.scheduler);
  const at = turn?.at;
  if (world.asks.kind === "wait" && at?.kind === "waiting") return `wait on ${at.wait.on}`;
  return world.asks.kind === "wait" ? "wait between turns" : world.asks.kind;
}

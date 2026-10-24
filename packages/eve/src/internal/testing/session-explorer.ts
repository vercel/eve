import { jsonSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { defaultDeliverResult } from "#channel/adapter.js";
import type { DeliverHookPayload, DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { admitDeliveries } from "#execution/session/delivery-facts.js";
import { attributeAnswers } from "#execution/session/answer-caller.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import { controlAdmitted, controlSettled } from "#harness/facts.js";
import { principalOf } from "#execution/session/principal.js";
import { on, type SchedulerEvent } from "#execution/session/scheduler/events.js";
import { next, type Next, type SessionReading } from "#execution/session/scheduler/next.js";
import {
  initialScheduler,
  turnOf,
  type Scheduler,
  type StepEnd,
} from "#execution/session/scheduler/state.js";
import { sessionReading } from "#execution/session/session-reading.js";
import { cancel, controlled } from "#harness/session-machine/transitions.js";
import {
  dropClosedRecords,
  saveTransition,
  sessionView,
  type Transition,
} from "#harness/session-machine/commit.js";
import { removeBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import type { ControlDelivery } from "#harness/types.js";
import { announcesWaiting, decideStep } from "#execution/session/step-decision.js";
import { readStepState } from "#execution/session/step-reading.js";
import { stepDisagreement } from "#execution/session/step-decision-check.js";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { eventsOf } from "#harness/publication.js";
import { cascade } from "#harness/session-machine/cascade.js";
import {
  currentProjection,
  currentView,
  enterSessionProjection,
  nextLinePosition,
  recordPublishedLine,
  saveProjection,
} from "#harness/session-machine/current.js";
import { runtimeWait, storedProjection, turnPosition } from "#harness/session-machine/view.js";
import { callStarted } from "#harness/call-facts.js";
import { announceWaiting } from "#harness/session-machine/waiting.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { takeAnswers } from "#harness/hitl/intake.js";
import { createStep } from "#harness/step/context.js";
import { stepProjection } from "#harness/session-machine/current.js";
import type {
  HarnessSession,
  HarnessStepInput,
  HandleEventFn,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { selectorAnswers } from "#internal/testing/selector-answers.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";
import { copyView, emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import {
  activeTurn,
  waiting,
  unansweredInteractions as unanswered,
} from "#protocol/session-projection/selectors.js";
import { promptQueueHead } from "#protocol/session-projection/reader.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { always } from "#tools/approval/policies.js";

// A session explored exhaustively, to a bound, through the real scheduler and the real harness
// step. Every point where the session waits on the world branches on everything the world can do
// there: Alice, whose session it is, and Bob write, answer, or approve; the model replies or calls
// tools; a tool's run reports. Each branch runs on a copy of the session, so every path up to the
// bound runs, and a path that reaches a state another already reached stops there.
//
// The scheduler is production's (`execution/session/scheduler/`): the explorer only does what it
// asks, as the session loop (`session-loop.ts`) does, in process. The step is
// `createToolLoopHarness`'s, with the admission `turn-step.ts` makes before it. Children, tasks,
// sign-ins, and run messages are outside its world; the scheduler checker reaches them.

export const ALICE = person("alice");
export const BOB = person("bob");
export type Person = typeof ALICE;

function person(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId,
    principalType: "user",
  };
}

const AT = "2030-01-01T00:00:00.000Z";

/**
 * Where the AI SDK's `generateId` takes its ids while the explorer runs, so a path mints the
 * same ids each time it runs. A test mocks `generateId` to read it (`exploredId`).
 */
const ID_SOURCE = Symbol.for("eve.session-explorer.ids");
type IdSource = { next: number };
const idSource = ((globalThis as { [ID_SOURCE]?: IdSource })[ID_SOURCE] ??= { next: 0 });

/** The next id a path mints. */
export function exploredId(): string {
  return `id_${idSource.next++}`;
}

/** What the model does in a step that calls it. */
export type ModelMove =
  | "reply"
  | "lookup"
  | "deploy"
  | "deploy+deploy"
  | "build"
  | "deploy+build"
  | "release"
  | "release+deploy";

export const MODEL_MOVES: readonly ModelMove[] = [
  "reply",
  "lookup",
  "deploy",
  "deploy+deploy",
  "build",
  "deploy+build",
  "release",
  "release+deploy",
];

/** Something the world does while the session waits, or during a step. */
export type Arrival =
  | { readonly kind: "message"; readonly from: Person }
  /** A message whose text answers the first open request, as a person types "approve". */
  | { readonly kind: "typed"; readonly from: Person; readonly text: "approve" | "deny" }
  | {
      readonly kind: "answer";
      readonly from: Person;
      readonly interactionId: string;
      readonly optionId: "approve" | "deny";
      /** The answer comes with a message, in one delivery. */
      readonly note?: true;
    }
  | { readonly kind: "result"; readonly callId: string }
  /** `session.cancel()`. */
  | { readonly kind: "cancel"; readonly from: Person }
  /** `session.clear()` or `session.compact()`. */
  | { readonly kind: "control"; readonly control: "clear" | "compact"; readonly from: Person };

/** Everything the explorer copies to branch: the session, its scheduler, and what readers saw. */
export interface World {
  readonly session: HarnessSession;
  readonly unreadInput?: true;
  /** The session's context auth between steps, as `turn-step.ts` leaves it. */
  readonly auth: SessionAuthContext | null;
  readonly complete: SessionView;
  readonly operational: SessionView;
  /** The session's scheduler, as production runs it. */
  readonly scheduler: Scheduler;
  /** What the scheduler waits on the world for: a step to run, or something to arrive. */
  readonly next?: Extract<Next, { readonly kind: "step" | "wait" }>;
  /**
   * What the turn's own person's message, sent while the turn waited on them, steers past: the
   * interactions open then, which must have settled by the time the session next waits.
   */
  readonly steersPast?: readonly string[];
  /** Whether the last step called the model: if not, its other moves are the same. */
  readonly calledModel?: boolean;
  readonly sent: readonly string[];
  readonly calls: number;
  /** The next id the path mints (`exploredId`). */
  readonly ids: number;
  /** What arrived since the turn began, which a closed exploration bounds. */
  readonly turnArrivals: number;
  readonly turns: number;
  readonly trail: readonly string[];
}

/**
 * Every kind of fact the exploration wrote, with its outcome, and how often: what it reached.
 * A finding-free run is only as strong as what this shows it ran.
 */
export const coverage = new Map<string, number>();

function cover(fact: SessionEvent): void {
  const data = fact.data as { readonly outcome?: unknown; readonly kind?: unknown };
  const detail =
    typeof data.outcome === "string"
      ? `:${data.outcome}`
      : typeof data.kind === "string"
        ? `:${data.kind}`
        : "";
  const key = `${fact.type}${detail}`;
  coverage.set(key, (coverage.get(key) ?? 0) + 1);
}

/** A broken promise, with the path that led to it. */
export interface Finding {
  readonly finding: string;
  readonly trail: readonly string[];
}

export function initialWorld(): World {
  return run(
    {
      auth: null,
      calls: 0,
      complete: emptySessionView(),
      ids: 0,
      operational: emptySessionView(),
      // A prewarmed session waits for its first message.
      scheduler: initialScheduler({ kind: "first-message" }),
      sent: [],
      session: {
        agent: { modelReference: { id: "explored" }, system: "Help Alice ship.", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "http:explored",
        history: [],
        sessionId: "explored",
      },
      trail: [],
      turnArrivals: 0,
      turns: 0,
    },
    [],
  );
}

/** What the explorer can do from `world`, given the bounds. */
export function choices(world: World, bounds: Bounds): readonly Choice[] {
  if (world.next === undefined) return [];
  if (world.next.kind === "step") {
    const during = bounds.duringStep
      ? arrivals(world, bounds).filter((a) => a.kind !== "result")
      : [];
    return MODEL_MOVES.flatMap((move): Choice[] => [
      { kind: "model", move },
      ...during.map((arrival): Choice => ({ during: arrival, kind: "model", move })),
    ]);
  }
  return arrivals(world, bounds);
}

/** How far the explorer goes. */
export interface Bounds {
  /** Deliveries the world sends in all. */
  readonly deliveries: number;
  /** Whether a delivery can arrive while a step runs. */
  readonly duringStep: boolean;
  /** Whether Alice cancels, clears, and compacts. */
  readonly controls?: boolean;
  /** How many deliveries the session may hold at once. */
  readonly held?: number;
  /** How many deliveries may arrive while one turn runs. */
  readonly turnArrivals?: number;
}

/** One thing the explorer does: the model's move for a step, with what arrives as it runs, or an arrival. */
export type Choice =
  | { readonly kind: "model"; readonly move: ModelMove; readonly during?: Arrival }
  | Arrival;

function arrivals(world: World, bounds: Bounds): Arrival[] {
  const options: Arrival[] = [];
  const calls = callsWaitedOn(world);
  if (calls !== undefined)
    for (const callId of calls.callIds)
      if (!calls.reported.has(callId)) options.push({ callId, kind: "result" });
  if (world.sent.length >= bounds.deliveries) return options;
  // What arrives while a turn runs is bounded, except what always moves the turn on: its own
  // person approving what it asks first.
  const piles =
    world.scheduler.held.entries.length < (bounds.held ?? Number.POSITIVE_INFINITY) &&
    world.turnArrivals < (bounds.turnArrivals ?? Number.POSITIVE_INFINITY);
  const open = Object.values(world.complete.interactions).filter((row) => row.status === "open");
  if (piles) {
    options.push({ from: ALICE, kind: "message" }, { from: BOB, kind: "message" });
    // Pre-start control settlement is covered by the checker and host tests, not this world.
    if (bounds.controls === true && world.complete.session.status !== "new") {
      options.push({ from: ALICE, kind: "cancel" });
      for (const control of ["clear", "compact"] as const)
        options.push({ control, from: ALICE, kind: "control" });
    }
    if (open.length > 0)
      options.push(
        { from: ALICE, kind: "typed", text: "approve" },
        { from: BOB, kind: "typed", text: "approve" },
      );
  }
  if (piles)
    for (const row of open) {
      for (const from of [ALICE, BOB])
        for (const optionId of ["approve", "deny"] as const)
          options.push({ from, interactionId: row.interactionId, kind: "answer", optionId });
      options.push({
        from: ALICE,
        interactionId: row.interactionId,
        kind: "answer",
        note: true,
        optionId: "approve",
      });
    }
  else {
    // The turn's own person approving what it asks first always moves the turn on.
    const head = promptQueueHead(world.complete);
    if (head !== undefined)
      options.push({
        from: ownerOf(world),
        interactionId: head.interactionId,
        kind: "answer",
        optionId: "approve",
      });
  }
  return options;
}

/** The calls the turn waits on, and which of them reported. */
function callsWaitedOn(
  world: World,
): { readonly callIds: readonly string[]; readonly reported: ReadonlySet<string> } | undefined {
  const at = turnOf(world.scheduler)?.at;
  if (world.next?.kind !== "wait" || at?.kind !== "waiting" || at.wait.on !== "calls")
    return undefined;
  return {
    callIds: at.wait.callIds,
    reported: new Set(at.wait.results.map((result) => result.callId)),
  };
}

/** Whoever the turn's steerer is, of Alice and Bob. */
function ownerOf(world: World): Person {
  return turnOf(world.scheduler)?.steerer.principal === principalOf(BOB) ? BOB : ALICE;
}

export function label(choice: Choice): string {
  switch (choice.kind) {
    case "model":
      return `model: ${choice.move}${choice.during === undefined ? "" : `, as ${label(choice.during)}`}`;
    case "message":
      return `${choice.from.principalId} writes`;
    case "typed":
      return `${choice.from.principalId} types "${choice.text}"`;
    case "answer":
      return `${choice.from.principalId} answers ${choice.interactionId} ${choice.optionId}${choice.note === true ? " and writes" : ""}`;
    case "result":
      return `${choice.callId} reports`;
    case "cancel":
      return `${choice.from.principalId} cancels`;
    case "control":
      return `${choice.from.principalId} ${choice.control}s`;
  }
}

/** Takes one choice from `world`, and runs the session until it next waits on the world. */
export async function advance(world: World, choice: Choice, findings: Finding[]): Promise<World> {
  const from: World = { ...world, trail: [...world.trail, label(choice)] };
  if (choice.kind === "model") {
    if (from.next?.kind !== "step") throw new Error("No step is about to run.");
    return run(await step(from, from.next, choice, findings), findings);
  }
  return run(arrive(from, choice), findings);
}

/** What the explorer reads of the world's session, as the session loop reads a durable one. */
function readingOf(world: World): SessionReading {
  return {
    ...sessionReading(world.session.state, {
      canAskPeople: true,
      principal: principalOf(world.auth),
      inboxPending: false,
      now: 0,
    }),
    // The explorer's workflow runs are simulated; dispatch still publishes their real receipts.
    recordedRuns: new Map(
      Object.values(world.complete.calls).flatMap((call) =>
        call.capability.name === "build" && call.status === "running"
          ? [[call.callId, call.capability.name] as const]
          : [],
      ),
    ),
  };
}

/**
 * Does what the scheduler asks, as the session loop does, until it waits on the world: for a
 * step's model move, or for something to arrive.
 */
function run(world: World, findings: Finding[]): World {
  let current = world;
  for (let performed = 0; performed < 200; performed += 1) {
    const decision = next(current.scheduler, readingOf(current));
    current = { ...current, scheduler: decision.state };
    const { asks } = decision;
    if (asks.kind === "step" || asks.kind === "wait") return { ...current, next: asks };
    const { next: _next, ...rest } = current;
    if (asks.kind === "end") return rest;
    const performed_ = perform(rest, asks, findings);
    current =
      performed_.event === undefined
        ? performed_.world
        : { ...performed_.world, scheduler: on(performed_.world.scheduler, performed_.event) };
  }
  findings.push({ finding: "the scheduler never waits", trail: current.trail });
  const { next: _next, ...ended } = current;
  return ended;
}

/** One thing the scheduler asks of the world, done to the explorer's session. */
function perform(
  world: World,
  asks: Exclude<Next, { readonly kind: "step" | "wait" | "end" }>,
  findings: Finding[],
): { readonly world: World; readonly event?: SchedulerEvent } {
  switch (asks.kind) {
    case "turn-started":
      return { world: { ...world, turnArrivals: 0, turns: world.turns + 1 } };
    case "end-turn":
      return { world };
    case "interrupt-runs":
    case "notify-parked":
    // The explorer's runs and tasks are no real runs: nothing is left of them to stop.
    case "cancel-tasks":
      return { world };
    case "route":
      // The session has no children, so every delivery stays the session's (`routeDeliverToChildren`).
      return {
        event: { kind: "routed", routed: { delivery: asks.delivery, kind: "remainder" } },
        world,
      };
    case "prewarm":
      // The explorer's session has no other deployment to move to.
      return { event: { kind: "transfer", transferred: false }, world };
    case "map-answers":
      // An http channel's `deliver` maps no answer onto another request's id.
      return { event: { kind: "mapped" }, world };
    case "dispatch":
      return {
        event: { at: 0, kind: "dispatched", results: [] },
        world: dispatched(world, findings),
      };
    case "admit-held": {
      const view = storedProjection(world.session.state).view;
      const facts = [
        ...asks.deliveries.flatMap((delivery) =>
          admitDeliveries({
            delivery,
            channelKind: "http",
            sessionStarted: true,
            status: (id) => view.deliveries[id]?.status,
            payloads: delivery.payloads.map((payload) => ({ payload, input: undefined })),
          }).facts.filter((event) => event.type === "delivery.admitted"),
        ),
        ...asks.controls.map(({ control, delivery }) => controlAdmitted(delivery, control)),
      ];
      return { world: publishOutsideStep(world, facts, findings) };
    }
    case "check-session-timeout":
      return { world, event: { kind: "session-timeout-checked", expired: false } };
    case "settle-control":
      return { world: publishOutsideStep(world, controlSettled(asks.settlement), findings) };
    case "settle-duplicate":
      throw new Error("The explorer assigns a fresh key to every delivery.");
    case "settle-cancelled-turn":
      return { world: settleCancelledTurn(world, asks.control, findings) };
    case "take-turn":
    case "hand-off":
      // The explorer's session stays on its one deployment.
      return { event: { kind: "transfer", transferred: false }, world };
    case "fail":
      findings.push({ finding: `the session fails: ${asks.message}`, trail: world.trail });
      return {
        world: {
          ...world,
          scheduler: { ...world.scheduler, phase: { end: { kind: "expired" }, kind: "ended" } },
        },
      };
    case "apply-run-messages":
    case "handle-run-message":
    case "start-task-calls":
    case "report-dropped":
      throw new Error(`The explorer's world sends nothing that asks to ${asks.kind}.`);
  }
}

/** Something the world sends: what the inbox delivers, and what the explorer counts of it. */
function sending(
  world: World,
  arrival: Arrival,
): { readonly world: World; readonly arrival: Parameters<typeof deliver>[1] } {
  if (arrival.kind === "result")
    return {
      arrival: {
        kind: "results",
        results: [
          {
            callId: arrival.callId,
            kind: "tool-result",
            output: { built: true },
            toolName: "build",
          },
        ],
      },
      world,
    };
  const sent = (deliveryId: string): World => ({
    ...world,
    sent: [...world.sent, deliveryId],
    turnArrivals: world.turnArrivals + 1,
  });
  if (arrival.kind === "cancel" || arrival.kind === "control") {
    const kind = arrival.kind === "cancel" ? "cancel" : arrival.control;
    const deliveryId = `${kind}_${world.sent.length}`;
    const origin = { auth: arrival.from, deliveryId };
    return {
      arrival:
        arrival.kind === "cancel"
          ? { kind: "cancel", origin }
          : { control: arrival.control, kind: "control", origin },
      world: sent(deliveryId),
    };
  }
  const deliveryId = `delivery_${world.sent.length}`;
  const payload: DeliverPayload =
    arrival.kind === "message"
      ? { message: `A note from ${arrival.from.principalId}` }
      : arrival.kind === "typed"
        ? { message: arrival.text }
        : {
            answers: [{ interactionId: arrival.interactionId, optionId: arrival.optionId }],
            ...(arrival.note === true && { message: `A note from ${arrival.from.principalId}` }),
          };
  const delivery: DeliverHookPayload = {
    auth: arrival.from,
    deliveryMetadata: [{ channelKind: "http", channelName: "test", deliveryId, payloadIndex: 0 }],
    kind: "deliver",
    payloads: [payload],
  };
  // The turn's own person's message, while the turn waits on them, steers past what it asked.
  const turn = turnOf(world.scheduler);
  const steers =
    turn?.steerer.principal === principalOf(arrival.from) &&
    world.next?.kind === "wait" &&
    turn.at.kind === "waiting" &&
    turn.at.wait.on === "interaction" &&
    (arrival.kind === "message" || (arrival.kind === "answer" && arrival.note === true));
  const steersPast = steers
    ? Object.values(world.complete.interactions)
        .filter((row) => row.status === "open")
        .map((row) => row.interactionId)
    : world.steersPast;
  return {
    arrival: { delivery, kind: "delivery" },
    world: { ...sent(deliveryId), ...(steersPast && { steersPast }) },
  };
}

/** Something arrives, as the session's inbox delivers it. */
function arrive(world: World, arrival: Arrival): World {
  const sent = sending(world, arrival);
  return deliver(sent.world, sent.arrival);
}

type SchedulerArrival = Extract<SchedulerEvent, { readonly kind: "arrived" }>["arrivals"][number];

function deliver(world: World, arrival: SchedulerArrival): World {
  return { ...world, scheduler: on(world.scheduler, { arrivals: [arrival], kind: "arrived" }) };
}

/**
 * `dispatchCoordinationStep`: each call the turn waits on runs from now, in its own run. Their
 * results arrive later, as the explorer chooses.
 */
function dispatched(world: World, findings: Finding[]): World {
  const tables = world.complete;
  const facts = (runtimeWait(world.session.state)?.tasks ?? [])
    .filter((task) => tables.calls[task.callId]?.status === "requested")
    .map((task) => callStarted(task.callId, { clearedBy: task.clearedBy, workflow: true }));
  return publishOutsideStep(world, facts, findings);
}

/** `settleCancelledTurnStep`: the cancel settles the turn, and what it took, through the machine. */
function settleCancelledTurn(
  world: World,
  control: ControlDelivery | undefined,
  findings: Finding[],
): World {
  const view = viewOfWorld(world);
  const turnId =
    runtimeWait(world.session.state)?.event.turnId ??
    activeTurn(view.projection.view)?.turnId ??
    "";
  const transition = controlled(control, "cancel", (cause) => cancel(view, { cause }));
  const stopped = applyOutsideStep(world, transition, findings);
  return {
    ...stopped,
    session: removeBlockingWorkflowToolRuns(
      { ...stopped.session, outputSchema: undefined },
      turnId,
    ),
  };
}

/** Publishes `facts` as a step outside the turn's does. */
function publishOutsideStep(
  world: World,
  facts: readonly SessionEvent[],
  findings: Finding[],
): World {
  if (facts.length === 0) return world;
  return applyOutsideStep(world, { events: facts, turn: viewOfWorld(world).turn }, findings);
}

/** Applies `transition` as a step outside the turn's own steps does: publishes it, then saves it. */
function applyOutsideStep(world: World, transition: Transition, findings: Finding[]): World {
  const complete = copyView(world.complete);
  const operational = copyView(world.operational);
  const ctx = new ContextContainer();
  enterSessionProjection(ctx, world.session.state);
  const sink = createSink(ctx, { complete, operational }, findings, world.trail);
  return contextStorage.run(ctx, () => {
    sink.publish(transition.events);
    const saved = dropClosedRecords(
      saveTransition(world.session, transition),
      currentProjection(ctx),
    );
    return {
      ...world,
      complete,
      operational,
      session: saveProjection(saved, currentProjection(ctx)),
    };
  });
}

/**
 * Writes what a step publishes as the session's writer does: closes what it ends (`cascade`),
 * checks each line against the stream's contract, and folds it, into the step's projection and
 * into both views a reader keeps.
 */
function createSink(
  ctx: ContextContainer,
  views: { readonly complete: SessionView; readonly operational: SessionView },
  findings: Finding[],
  trail: readonly string[],
) {
  const checker = createStreamChecker({
    seed: copyView(views.complete),
    validate: schemaViolation,
  });
  const publish = (events: readonly SessionEvent[]) => {
    const closed = cascade(currentView(ctx), events);
    for (const line of linesOf(closed, AT)) {
      const position = nextLinePosition(ctx);
      for (const violation of checker.check(line, position))
        findings.push({
          finding: `${violation.rule} at ${position}: ${violation.message}`,
          trail,
        });
      recordPublishedLine(ctx, line, position, eventsOfLine(line, position, AT));
      if ("facts" in line) for (const fact of line.facts) cover(fact);
      foldLine(views.complete, line, position);
      foldLine(views.operational, line, position, { retention: "operational" });
      if (
        JSON.stringify(selectorAnswers(views.complete, views.operational)) !==
        JSON.stringify(selectorAnswers(views.operational))
      )
        findings.push({ finding: `the operational view answers otherwise at ${position}`, trail });
    }
  };
  const handleEvent: HandleEventFn = async (publication) => publish(eventsOf(publication));
  return { handleEvent, publish };
}

const tools: ReadonlyMap<string, HarnessToolDefinition> = new Map(
  (
    [
      {
        description: "Look something up.",
        execute: async () => ({ found: true }),
        inputSchema: jsonSchema({ type: "object" }),
        name: "lookup",
      },
      {
        approval: always(),
        description: "Deploy, once someone approves.",
        execute: async () => ({ deployed: true }),
        inputSchema: jsonSchema({ type: "object" }),
        name: "deploy",
      },
      {
        // Anyone on the team may approve a release, but only Alice may turn one down.
        approval: {
          request: always(),
          response: ({ response }) =>
            response.decision === "approve" || response.principal.principalId === "alice"
              ? { status: "allowed" }
              : { reason: "Only Alice turns a release down.", status: "rejected" },
        },
        description: "Release, once someone on the team approves.",
        execute: async () => ({ released: true }),
        inputSchema: jsonSchema({ type: "object" }),
        name: "release",
      },
      {
        description: "Build, which a workflow runs.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "build",
        workflowId: "workflow//./agent/tools/build//execute",
      },
    ] satisfies HarnessToolDefinition[]
  ).map((tool) => [tool.name, tool]),
);

/**
 * One turn step, as `turn-step.ts` runs it: the delivery is admitted, its answers attributed to
 * who gave them, and the harness runs with it, the model making `move`. What arrives during the
 * step is admitted at its end, as the turn's boundary does.
 */
async function step(
  world: World,
  asks: Extract<Next, { readonly kind: "step" }>,
  choice: Extract<Choice, { kind: "model" }>,
  findings: Finding[],
): Promise<World> {
  const { input: payload } = asks;
  const { move } = choice;
  const complete = copyView(world.complete);
  const operational = copyView(world.operational);
  const ctx = new ContextContainer();
  let calls = world.calls;
  let calledModel = false;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calledModel = true;
      if (move === "reply") return textStreamResult("Done.");
      return toolCallsStreamResult(
        move
          .split("+")
          .map((toolName) => ({ input: "{}", toolCallId: `call_${calls++}`, toolName })),
      );
    },
    modelId: "explored",
    provider: "eve-explorer",
  });
  const sink = createSink(ctx, { complete, operational }, findings, world.trail);
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    clearOnly: payload?.control === "clear",
    compactOnly: payload?.control === "compact",
    controlDelivery: payload?.controlDelivery,
    handleEvent: sink.handleEvent,
    resolveModel: async () => model,
    tools,
  };
  const position = turnPosition(storedProjection(world.session.state));
  ctx.set(SessionIdKey, world.session.sessionId);
  ctx.set(AuthKey, world.auth);
  ctx.set(SessionKey, {
    auth: { current: world.auth, initiator: null },
    sessionId: world.session.sessionId,
    turn: { id: position.turnId, sequence: position.sequence },
  });
  enterSessionProjection(ctx, world.session.state);
  const before = copyView(currentView(ctx));
  let input: HarnessStepInput | undefined;
  const delivery = payload?.delivery;
  if (delivery !== undefined) {
    const previous = ctx.get(AuthKey) ?? null;
    if (delivery.auth !== undefined) ctx.set(AuthKey, delivery.auth);
    const taken = takeDelivery({
      status: (deliveryId) => currentView(ctx).deliveries[deliveryId]?.status,
      betweenTurns: activeTurn(currentView(ctx)) === undefined,
      channelKind: "http",
      delivery,
      payloads: delivery.payloads.map((payload) => ({
        input: defaultDeliverResult(payload),
        payload,
      })),
      sender: delivery.auth,
      sessionStarted: position.sessionStarted,
      state: world.session.state,
    });
    const { admission } = taken;
    input = taken.input;
    if (taken.acts === "as-before") ctx.set(AuthKey, previous);
    const started = position.sessionStarted
      ? []
      : [{ data: {}, type: "session.started" } as SessionEvent];
    const facts = [...started, ...admission.facts];
    if (facts.length > 0) contextStorage.run(ctx, () => sink.publish(facts));
  }
  const results = payload?.runtimeResults?.results;
  if (results !== undefined) input = { ...input, runtimeActionResults: [...results] };
  let session: HarnessSession;
  let result: StepResult;
  idSource.next = world.ids;
  try {
    result = await contextStorage.run(ctx, () =>
      createToolLoopHarness(config)(world.session, input),
    );
    session = result.session;
  } catch (error) {
    findings.push({ finding: `the step threw: ${String(error)}`, trail: world.trail });
    return ended(world);
  }
  const decision = decideStep(readStepState(session, result.unreadInput));
  checkStepContract(before, storedProjection(session.state).view, asks, findings, world.trail);
  const disagreement = stepDisagreement(
    resolveSessionStepResult(result, {}),
    storedProjection(session.state).view,
  );
  if (disagreement !== undefined && disagreement !== "dispatch-deferred")
    findings.push({ finding: `the decision disagrees: ${disagreement}`, trail: world.trail });
  if (announcesWaiting(decision)) {
    const announced = announceWaiting(before, currentView(ctx));
    if (announced.length > 0) contextStorage.run(ctx, () => sink.publish(announced));
  }
  session = saveProjection(session, currentProjection(ctx));
  let stepped: World = {
    ...world,
    auth: ctx.get(AuthKey) ?? null,
    calledModel,
    unreadInput: result.unreadInput,
    calls,
    complete,
    ids: idSource.next,
    operational,
    session,
  };
  if (
    decision.kind === "run" &&
    JSON.stringify(session.state) === JSON.stringify(world.session.state) &&
    JSON.stringify(session.history) === JSON.stringify(world.session.history) &&
    delivery === undefined &&
    results === undefined
  ) {
    findings.push({ finding: "a step changes nothing and runs again", trail: world.trail });
    return ended(stepped);
  }
  // What arrived while the step ran, its boundary admits.
  const during = choice.during === undefined ? undefined : sending(stepped, choice.during);
  if (during !== undefined) stepped = during.world;
  const durable = resolveSessionStepResult({ ...result, session }, {});
  const { history: _history, serializedContext: _context, sessionState: _state, ...end } = durable;
  const arrivals = during === undefined ? [] : [during.arrival];
  return {
    ...stepped,
    scheduler: on(stepped.scheduler, { arrivals, kind: "stepped", result: end as StepEnd }),
  };
}

function takeDelivery(
  input: Parameters<typeof admitDeliveries>[0] & {
    readonly state: HarnessSession["state"];
    readonly sender: SessionAuthContext | null | undefined;
    readonly betweenTurns: boolean;
  },
) {
  const admission = admitDeliveries(input);
  const merged =
    admission.inputs.length === 0 ? undefined : admission.inputs.reduce(coalesceTurnInputs);
  const attributed =
    input.sender === undefined
      ? undefined
      : attributeAnswers({
          responder: input.sender,
          state: input.state,
          stepInput: merged,
        });
  return {
    admission,
    input: attributed ?? merged,
    acts: attributed === undefined ? "as-sender" : "as-before",
  };
}

/**
 * What the scheduler checker assumes a step does with what it's given (`scheduler-checker.ts`,
 * `takeInput`), checked against the real step: every delivery it takes is on the stream; an answer
 * leaves its interaction awaiting nothing more (a batch of approvals closes together, once each
 * has one), waits for the response policy the next step runs, or is refused, as its responder may
 * not give it; the turn's own message, unless it types an answer, steers past everything the turn
 * asked; and a clear ends the open turn and settles its control.
 */
function checkStepContract(
  before: SessionView,
  after: SessionView,
  asks: Extract<Next, { readonly kind: "step" }>,
  findings: Finding[],
  trail: readonly string[],
): void {
  const fail = (finding: string) => findings.push({ finding: `contract: ${finding}`, trail });
  const input = asks.input;
  const delivery = input?.delivery;
  const metadata = delivery?.deliveryMetadata ?? [];
  for (const { deliveryId } of metadata)
    if (after.deliveries[deliveryId] === undefined) fail(`${deliveryId} is off the stream`);
  const awaiting = new Set(unanswered(after).map((row) => row.interactionId));
  const wasAwaiting = new Set(unanswered(before).map((row) => row.interactionId));
  // An answer a response policy weighs waits, submitted, for the turn's next step.
  const weighing = new Set(
    Object.values(after.responses).flatMap((row) =>
      row.status === "submitted" ? [row.interactionId] : [],
    ),
  );
  // An answer its responder may not give is refused: its delivery settles, and it asks again.
  const refused = metadata.some(
    ({ deliveryId }) => after.deliveries[deliveryId]?.outcome === "refused",
  );
  for (const payload of delivery?.payloads ?? [])
    for (const answer of payload.answers ?? [])
      if (
        wasAwaiting.has(answer.interactionId) &&
        awaiting.has(answer.interactionId) &&
        !weighing.has(answer.interactionId) &&
        !refused
      )
        fail(`${answer.interactionId} awaits an answer after its answer`);
  const answeredBy = new Set(Object.values(after.responses).map((row) => row.deliveryId));
  const steers = delivery?.payloads.some((payload, index) => {
    const id = metadata.find((entry) => entry.payloadIndex === index)?.deliveryId;
    return payload.message !== undefined && (id === undefined || !answeredBy.has(id));
  });
  if (steers === true && activeTurn(before) !== undefined)
    for (const id of wasAwaiting)
      if (awaiting.has(id)) fail(`${id} awaits an answer past a message`);
  if (input?.control === "clear") {
    if (activeTurn(after) !== undefined) fail("a clear leaves the turn open");
    const id = input.controlDelivery?.deliveryId;
    if (id !== undefined && after.deliveries[id]?.status !== "settled")
      fail(`the clear ${id} stays unsettled`);
  }
}

function ended(world: World): World {
  const { next: _next, ...rest } = world;
  return {
    ...rest,
    scheduler: { ...rest.scheduler, phase: { end: { kind: "expired" }, kind: "ended" } },
  };
}

function viewOfWorld(world: World) {
  return sessionView(storedProjection(world.session.state), world.session.state);
}

/** Whether the session waits between turns. */
function betweenTurns(world: World): boolean {
  return world.next?.kind === "wait" && world.scheduler.phase.kind === "between-turns";
}

/** What readers hold true once the session waits on the world. */
export function checkWaiting(world: World, findings: Finding[]): void {
  if (world.next?.kind !== "wait") return;
  const view = world.complete;
  // The turn's own person's message steers past everything the turn asked them.
  for (const interactionId of world.steersPast ?? [])
    if (view.interactions[interactionId]?.status === "open")
      findings.push({
        finding: `${interactionId} stays open after the turn's own person wrote past it`,
        trail: world.trail,
      });
  for (const deliveryId of world.sent)
    if (view.deliveries[deliveryId] === undefined)
      findings.push({
        finding: `${deliveryId} arrived, but no reader sees it`,
        trail: world.trail,
      });
  const turn = activeTurn(view);
  if (turn === undefined) {
    if (!betweenTurns(world))
      findings.push({ finding: "the session waits with no turn open", trail: world.trail });
    return;
  }
  const waits = waiting(view, turn.turnId);
  if (waits?.on === "session")
    findings.push({
      finding: `${turn.turnId} reads as the session's work while it waits`,
      trail: world.trail,
    });
}

/** Ends everything open as the turn's person would, and checks nothing is left. */
export async function drain(world: World, findings: Finding[]): Promise<void> {
  for (let move = 0; move < 30; move += 1) {
    if (world.next === undefined) return;
    if (betweenTurns(world)) break;
    if (world.next.kind === "step") {
      world = await advance(world, { kind: "model", move: "reply" }, findings);
      continue;
    }
    const options = choices(world, { deliveries: Number.POSITIVE_INFINITY, duringStep: false });
    const result = options.find((option) => option.kind === "result");
    const head = promptQueueHead(world.complete);
    const next: Arrival | undefined =
      result ??
      (head === undefined
        ? undefined
        : {
            from: ownerOf(world),
            interactionId: head.interactionId,
            kind: "answer",
            optionId: "approve",
          });
    if (next === undefined) {
      findings.push({ finding: "the turn waits on nothing anyone can give", trail: world.trail });
      return;
    }
    world = await advance(world, next, findings);
  }
  if (!betweenTurns(world)) {
    findings.push({ finding: "the session never settles", trail: world.trail });
    return;
  }
  for (const deliveryId of world.sent)
    if (world.complete.deliveries[deliveryId]?.status !== "settled")
      findings.push({ finding: `${deliveryId} never settled`, trail: world.trail });
}

/** The state two paths share when they reach the same session the same way. */
export function fingerprint(world: World): string {
  // What the session's future depends on, and what the checks of it read: the complete view folds
  // every fact the session ever wrote, which its state keeps only as long as retention does.
  return JSON.stringify({
    complete: world.complete,
    ids: world.ids,
    auth: world.auth,
    history: world.session.history,
    next: world.next,
    scheduler: world.scheduler,
    state: world.session.state,
    unreadInput: world.unreadInput,
  });
}

/**
 * Takes deliveries the explorer doesn't send through production's answer intake,
 * checking every reachable state and every way to answer
 * what it asks. A person answers a whole batch at once, answers and writes in one delivery, or
 * answers what already closed; the step that takes it may have just taken runtime results.
 */
export async function checkTakingAnswers(world: World, findings: Finding[]): Promise<number> {
  const tables = world.complete;
  if (activeTurn(tables) === undefined) return 0;
  const rows = Object.values(tables.interactions).filter((row) => row.request.kind === "approval");
  const open = rows.filter((row) => row.status === "open");
  const deliveries: {
    readonly label: string;
    readonly payload: DeliverPayload;
    readonly from: Person;
  }[] = [];
  for (const from of [ALICE, BOB])
    for (const optionId of ["approve", "deny"] as const) {
      if (open.length > 1)
        deliveries.push({
          from,
          label: `${from.principalId} answers every open approval ${optionId}`,
          payload: { answers: open.map((row) => ({ interactionId: row.interactionId, optionId })) },
        });
      for (const row of open)
        deliveries.push({
          from,
          label: `${from.principalId} answers ${row.interactionId} ${optionId} and writes`,
          payload: {
            answers: [{ interactionId: row.interactionId, optionId }],
            message: `A note from ${from.principalId}`,
          },
        });
      for (const row of rows.filter((entry) => entry.status === "settled"))
        deliveries.push({
          from,
          label: `${from.principalId} answers ${row.interactionId}, which closed, ${optionId}`,
          payload: { answers: [{ interactionId: row.interactionId, optionId }] },
        });
    }
  let checked = 0;
  for (const { from, label: what, payload } of deliveries)
    for (const takeQueued of [true, false]) {
      checked += 1;
      await checkTaking(world, { from, payload, takeQueued, what }, findings);
    }
  return checked;
}

async function checkTaking(
  world: World,
  given: {
    readonly from: Person;
    readonly payload: DeliverPayload;
    readonly takeQueued: boolean;
    readonly what: string;
  },
  findings: Finding[],
): Promise<void> {
  const trail = [...world.trail, `${given.what}${given.takeQueued ? "" : ", after results"}`];
  const tables = world.complete;
  const deliveryId = "delivery_checked";
  const delivery: DeliverHookPayload = {
    auth: given.from,
    deliveryMetadata: [{ channelKind: "http", channelName: "test", deliveryId, payloadIndex: 0 }],
    kind: "deliver",
    payloads: [given.payload],
  };
  const took = takeDelivery({
    status: () => undefined,
    betweenTurns: false,
    channelKind: "http",
    delivery,
    payloads: [{ input: defaultDeliverResult(given.payload), payload: given.payload }],
    sender: given.from,
    sessionStarted: true,
    state: world.session.state,
  });
  const { admission, input } = took;
  // `turn-step.ts` answers as the sender, unless their answers alone were attributed to them.
  const caller = took.acts === "as-sender" ? given.from : world.auth;
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, world.session.sessionId);
  ctx.set(AuthKey, caller);
  ctx.set(SessionKey, {
    auth: { current: caller, initiator: null },
    sessionId: world.session.sessionId,
    turn: { id: activeTurn(tables)!.turnId, sequence: 0 },
  });
  enterSessionProjection(ctx, world.session.state);
  const view = copyView(tables);
  const sink = createSink(
    ctx,
    { complete: view, operational: copyView(world.operational) },
    findings,
    trail,
  );
  const written: SessionEvent[] = [];
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    tools,
    resolveModel: async () =>
      new MockLanguageModelV4({ doStream: async () => textStreamResult("Done.") }),
  };
  const step = createStep({
    config,
    ctx,
    emit: sink.handleEvent,
    instrumentation: undefined,
    live: stepProjection(ctx, world.session.state),
    publish: async (publication) => {
      written.push(...eventsOf(publication));
      await sink.handleEvent(publication);
    },
    session: world.session,
  });
  const taken = await contextStorage.run(ctx, async () => {
    await step.apply({ events: admission.facts, turn: step.view().turn });
    return takeAnswers(step, { input, waited: !given.takeQueued });
  });
  const find = (finding: string) => findings.push({ finding, trail });

  // 2. Without a response policy, only the person who asked decides an approval.
  for (const fact of written) {
    if (fact.type !== "interaction.settled" || fact.data.cause === undefined) continue;
    if (!("responseId" in fact.data.cause)) continue;
    const response = view.responses[fact.data.cause.responseId];
    const principal =
      response === undefined ? undefined : view.deliveries[response.deliveryId]?.principal?.id;
    const call = view.interactions[fact.data.interactionId]?.subject;
    const tool =
      call !== undefined && "callId" in call ? view.calls[call.callId]?.capability.name : undefined;
    const requester = activeTurnOwner(view);
    if (tool === "deploy" && principal !== undefined && principal !== requester)
      find(`${principal}'s answer decided ${fact.data.interactionId}, which only ${requester} may`);
  }

  // 3. The delivery settles, the turn takes it, or it waits in the turn's queue.
  const queued = step
    .view()
    .turn.queued?.deliveries?.some((entry) => entry.deliveryId === deliveryId);
  const takes =
    !("ended" in taken) &&
    taken.input?.deliveries?.some((entry) => entry.deliveryId === deliveryId);
  if (view.deliveries[deliveryId]?.status !== "settled" && queued !== true && takes !== true)
    find("the delivery is neither settled, taken, nor held");

  // 4. A step that stops leaves the session waiting, or with something the next step takes.
  if (
    "ended" in taken &&
    decideStep(readStepState(saveProjection(step.session, currentProjection(ctx)))).kind === "run"
  ) {
    const before = JSON.stringify({ session: step.session, projection: currentProjection(ctx) });
    const next = await contextStorage.run(ctx, () =>
      takeAnswers(step, { input: undefined, waited: false }),
    );
    if (
      "ended" in next &&
      JSON.stringify({ session: step.session, projection: currentProjection(ctx) }) === before
    )
      find("the step stops, runs again, and stops where it was");
  }
}

/** Whose turn is open: the principal of the delivery that started it. */
function activeTurnOwner(view: SessionView): string | undefined {
  const cause = activeTurn(view)?.cause;
  return cause !== undefined && "deliveryId" in cause
    ? view.deliveries[cause.deliveryId]?.principal?.id
    : undefined;
}

/**
 * What the session's rules read of its state, and nothing else: its open rows and who answered
 * them, what the turn holds privately, what the scheduler holds, and what it does next. Two
 * sessions with one abstraction should do the same things; `close` checks that they do, by
 * expanding a second session for each and comparing where their choices lead.
 */
export function abstraction(world: World, bounds?: Bounds): string {
  const tables = storedProjection(world.session.state).view;
  const machine = sessionView(storedProjection(world.session.state), world.session.state);
  const turn = turnOf(world.scheduler);
  const wait = turn?.at.kind === "waiting" ? turn.at.wait : undefined;
  const heldSince = wait?.on === "interaction" ? wait.heldSince : undefined;
  const principalOfResponse = (responseId: string) => {
    const response = tables.responses[responseId];
    return response === undefined
      ? undefined
      : tables.deliveries[response.deliveryId]?.principal?.id;
  };
  const toolOf = (callId: string) => tables.calls[callId]?.capability.name;
  const callIds = new Map<string, number>();
  const callName = (callId: string) => {
    if (!callIds.has(callId)) callIds.set(callId, callIds.size);
    return callIds.get(callId);
  };
  const reported = new Set(wait?.on === "calls" ? wait.results.map((result) => result.callId) : []);
  // An answer is about the call its interaction asks about, named as the summary names calls.
  const answerOf = (answer: { readonly interactionId: string; readonly optionId?: string }) => {
    const row = tables.interactions[answer.interactionId];
    const subject = row?.subject;
    return {
      call: subject !== undefined && "callId" in subject ? callName(subject.callId) : undefined,
      open: row?.status === "open",
      optionId: answer.optionId,
    };
  };
  const shapeOf = (input: HarnessStepInput | undefined) =>
    input === undefined
      ? undefined
      : {
          answers: input.answers?.length ?? 0,
          context: input.context?.length ?? 0,
          deliveries: input.deliveries?.length ?? 0,
          message: input.message !== undefined,
          results: input.runtimeActionResults?.length ?? 0,
        };
  const payloadsOf = (delivery: DeliverHookPayload | undefined) =>
    delivery?.payloads.map((payload) => ({
      answers: payload.answers?.map(answerOf),
      message: payload.message,
    }));
  const { next: step } = world;
  const summary = {
    auth: world.auth?.principalId ?? null,
    calls: Object.values(tables.calls)
      .filter((row) => row.status !== "settled")
      .sort((a, b) => a.introducedAt - b.introducedAt)
      .map((row) => ({
        call: callName(row.callId),
        reported: reported.has(row.callId),
        status: row.status,
        tool: row.capability.name,
        workflow: row.workflow === true,
      })),
    cancelling: turn?.stopping === true,
    changes: Object.values(tables.changes)
      .filter((row) => row.status !== "settled")
      .map((row) => row.kind),
    deliveries: Object.values(tables.deliveries)
      .filter((row) => row.status !== "settled")
      .map((row) => ({ from: row.principal?.id, status: row.status })),
    held: world.scheduler.held.entries.map((entry) =>
      entry.kind === "delivery"
        ? {
            admitted: turn?.admitted.includes(entry.sequence) === true,
            afterAsking: heldSince !== undefined && entry.sequence >= heldSince,
            from: entry.delivery.auth?.principalId,
            payloads: payloadsOf(entry.delivery),
          }
        : { control: entry.kind === "control" ? entry.control : entry.kind },
    ),
    history: (() => {
      const last = world.session.history.at(-1);
      return {
        unreadInput: readStepState(world.session, world.unreadInput).unreadInput,
        last: last?.role,
        empty: world.session.history.length === 0,
      };
    })(),
    interactions: Object.values(tables.interactions)
      .filter((row) => row.status === "open")
      .sort((a, b) => a.introducedAt - b.introducedAt)
      .map((row) => {
        const responses = Object.values(tables.responses).filter(
          (response) =>
            response.interactionId === row.interactionId && response.status !== "settled",
        );
        return {
          about:
            "callId" in row.subject
              ? { call: callName(row.subject.callId), tool: toolOf(row.subject.callId) }
              : Object.keys(row.subject)[0],
          kind: row.request.kind,
          responses: responses.map((response) => ({
            from: principalOfResponse(response.responseId),
            status: response.status,
            weighs: machine.responders[response.responseId] !== undefined,
          })),
        };
      }),
    next:
      step?.kind === "step"
        ? {
            control: step.input?.control,
            from: step.input?.delivery?.auth?.principalId,
            kind: "step",
            payloads: payloadsOf(step.input?.delivery),
            results: step.input?.runtimeResults?.results.map((result) => callName(result.callId)),
          }
        : step?.kind === "wait" && wait !== undefined
          ? {
              calls: wait.on === "calls" ? wait.callIds.map(callName) : undefined,
              kind: "wait",
              on: wait.on,
              requests: wait.on === "interaction" ? wait.requestIds.length : undefined,
            }
          : { kind: step === undefined ? "ended" : "between-turns" },
    runs: Object.values(tables.runs).filter((row) => row.status !== "settled").length,
    signIns: machine.signIns.length,
    started: tables.session.status !== "new",
    turn: activeTurn(tables) === undefined ? undefined : turn?.steerer.principal,
    // Past its bound, how many arrived changes nothing the explorer can do.
    turnArrivals: Math.min(world.turnArrivals, bounds?.turnArrivals ?? Number.POSITIVE_INFINITY),
    turnState: {
      remembered: Object.keys(machine.turn.remembered).length,
      queued: shapeOf(machine.turn.queued),
      suspended: machine.turn.suspended.map((suspended) => ({
        requests: suspended.requests.map((request) => ({
          call: callName(request.call.callId),
          open: tables.interactions[request.interactionId]?.status === "open",
          tool: request.call.toolName,
        })),
        tasks: suspended.tasks.map((task) => callName(task.callId)),
      })),
    },
  };
  return JSON.stringify(summary);
}

/** Whether nothing is left anywhere: no turn, nothing held, nothing open. */
export function quiet(world: World): boolean {
  if (!betweenTurns(world)) return false;
  const tables = storedProjection(world.session.state).view;
  return (
    world.scheduler.held.entries.length === 0 &&
    activeTurn(tables) === undefined &&
    Object.values(tables.deliveries).every((delivery) => delivery.status === "settled") &&
    Object.values(tables.interactions).every((row) => row.status === "settled") &&
    Object.values(tables.calls).every((row) => row.status === "settled")
  );
}

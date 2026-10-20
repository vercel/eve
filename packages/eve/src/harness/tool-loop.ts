import { activeTurnIdOf } from "#protocol/session-projection.js";
import { contextStorage } from "#context/container.js";
import { StaticModelReferenceKey } from "#context/keys.js";
import { GenerationSteering } from "#harness/generation-steering.js";
import { compactHistory, replaceSessionHistory } from "#harness/compaction/step.js";
import { runModelStep } from "#harness/model-call/run.js";
import { handleStepResult } from "#harness/step/after-model.js";
import type { Publish } from "#harness/session-machine/commit.js";
import {
  saveProjection,
  stepProjection,
  type StepProjection,
} from "#harness/session-machine/current.js";
import {
  admitHumanInput,
  applyHumanDecisions,
  compactInput,
  discardClearedHumanInput,
  openDeferredApprovals,
  queueInput,
  settleHumanInput,
  turnInputOnly,
  withoutTurnInput,
} from "#harness/hitl/index.js";
import { blocked, park } from "#harness/step/park.js";
import {
  clear,
  controlDeliveryFor,
  controlled,
  join,
} from "#harness/session-machine/transitions.js";
import { turnPosition } from "#harness/session-machine/view.js";
import { createStep, openTurn, type Step } from "#harness/step/context.js";
import { prepareTurnInput, settleRuntimeWork } from "#harness/step/intake.js";
import type {
  HarnessSession,
  StepFn,
  HarnessStepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import type { InstrumentationStepScope } from "#instrumentation/runtime.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createHistoryViewPreparer } from "#shared/history-view.js";
import { eventsOf } from "#harness/publication.js";
import { clearMemorySessionState } from "#shared/memory-state.js";

const environment = process.env.NODE_ENV ?? "unknown";
const eveVersion = resolveInstalledPackageInfo().version;

/**
 * Creates the harness step: one step of a session, backed by the AI SDK's `ToolLoopAgent`.
 *
 * A step settles what earlier steps parked and takes its delivery's answers, opens or joins the
 * turn, runs the work those answers approved, then makes one model step and acts on its response.
 * Every lifecycle change goes through the session machine (`Step.apply`).
 */
export function createToolLoopHarness(config: ToolLoopHarnessConfig): StepFn {
  config.instrumentation?.installAiSdkWarningLogger();

  async function runStep(
    initialSession: Readonly<Parameters<StepFn>[0]>,
    input?: HarnessStepInput,
  ): Promise<StepResult> {
    const executeStep = async (scope?: InstrumentationStepScope<HarnessSession>) => {
      const current = scope?.session ?? initialSession;
      const live = stepProjection(contextStorage.getStore(), current.state);
      const generation = new GenerationSteering({
        abortSignal: config.abortSignal,
        steeringSignal: config.steeringSignal,
        outputStarted: turnPosition(live.read()).assistantOutputStarted,
      });
      try {
        const result = await executeStepBody(current, generation, live, input, scope);
        // The step saves the lifecycle it published with the state that follows it.
        return { ...result, session: saveProjection(result.session, live.read()) };
      } finally {
        generation.dispose();
      }
    };
    return (
      config.instrumentation?.runStep(
        { environment, eveVersion, hasInput: hasStepInput(input), session: initialSession },
        executeStep,
      ) ?? executeStep()
    );
  }

  async function executeStepBody(
    initialSession: HarnessSession,
    generation: GenerationSteering,
    live: StepProjection,
    input: HarnessStepInput | undefined,
    instrumentation: InstrumentationStepScope<HarnessSession> | undefined,
  ): Promise<StepResult> {
    const prepareHistory = createHistoryViewPreparer({
      previous: config.historyView,
      projector: config.historyProjector,
    });
    prepareHistory(initialSession.history, initialSession.state);
    const ctx = contextStorage.getStore();
    if (ctx !== undefined && !ctx.has(StaticModelReferenceKey)) {
      ctx.setVirtualContext(
        StaticModelReferenceKey,
        initialSession.agent.dynamicModel === true
          ? null
          : (initialSession.agent.modelReference ?? null),
      );
    }
    const emit =
      instrumentation?.createHandleEvent({
        isFrameworkTool: (name) => step.frameworkToolNames.has(name),
        handleEvent: config.handleEvent,
      }) ?? config.handleEvent;
    const publish: Publish = async (publication, messages) => {
      const events = eventsOf(publication);
      for (const event of events) generation.beforeEvent(event);
      // The publish sink folds what it publishes; without a sink, the step does, so lifecycle
      // never depends on whether a caller listens.
      if (emit !== undefined) await emit(publication, messages);
      if (emit === undefined || ctx === undefined) live.record(events);
    };
    const step = createStep({
      config,
      ctx,
      emit,
      instrumentation,
      live,
      prepareHistory,
      publish,
      runStep,
      session: initialSession,
    });

    if (config.clearOnly === true) return clearContext(step);
    if (config.compactOnly === true) return compactHistory(step);

    // A step takes what arrived, in order: the runtime's results, then people's answers, then
    // the delivery's input. Then it acts: what the answers approved runs, or the turn waits on
    // people, or the model runs.
    const runtime = await runtimeResults(step, input);
    if ("ended" in runtime) return runtime.ended;
    const answered = await answers(step, runtime);
    if ("ended" in answered) return answered.ended;
    const turn = await turnInput(step, input, answered);
    if ("ended" in turn) return turn.ended;
    const stopped = await applyHumanDecisions(step, answered.decided);
    if (stopped !== undefined) return stopped;
    if (blocked(step.view(), step.session.state)) return park(step);
    return runModelStep(step, {
      onResponse: (response) => handleStepResult(step, response),
      generation,
      turn,
    });
  }

  return runStep;
}

/** A stage's result when the step ends there. */
interface Ended {
  readonly ended: StepResult;
}

/**
 * Results the runtime ran for parked steps settle first, and approvals deferred behind the tasks
 * that settled open; queued input waits for all of them.
 */
async function runtimeResults(step: Step, input: HarnessStepInput | undefined) {
  const runtime = await settleRuntimeWork(step, input);
  if (runtime === undefined) return { ended: { next: null, session: step.session } } as Ended;
  await step.apply(openDeferredApprovals(step.view()));
  return runtime;
}

/**
 * The delivery's answers are admitted, then decide what they answer. The model reads what they
 * decided before the delivery's own input, as the AI SDK ran it, so that input waits a step; and
 * when nothing they decided can run, it waits, unreceived, behind them.
 */
async function answers(
  step: Step,
  runtime: NonNullable<Awaited<ReturnType<typeof settleRuntimeWork>>>,
) {
  const intake = await admitHumanInput(step, runtime.input, { takeQueued: !runtime.waited });
  if (intake.kind === "stop") return { ended: intake.result } as Ended;
  const decided = await settleHumanInput(step, intake);
  let { input, message } = intake;
  if (decided.approved.length > 0 || decided.settledApprovals) {
    await step.apply(queueInput(step.view(), turnInputOnly(input)));
    input = withoutTurnInput(input);
    message = undefined;
  }
  if (decided.approved.length === 0 && blocked(step.view(), step.session.state)) {
    await step.apply(queueInput(step.view(), compactInput(input)));
    return { ended: await park(step) } as Ended;
  }
  return { decided, input, intake, message };
}

/**
 * The delivery's input opens the turn, or joins the one its answers resume. Input that opened no
 * turn and found none open, such as a stale answer eve dropped, settled and leaves nothing to run.
 */
async function turnInput(
  step: Step,
  input: HarnessStepInput | undefined,
  { input: received, intake, message }: Exclude<Awaited<ReturnType<typeof answers>>, Ended>,
) {
  const turn = await prepareTurnInput(step, received, { consumedMessage: intake.consumedMessage });
  // A delivery an earlier step queued joins with the input the queue carried it in.
  const deliveries = deliveriesOf(input, received);
  if (intake.opensTurn) {
    const failed = await openTurn(step, {
      deliveries,
      input: [...turn.ephemeral, ...turn.messages],
      message,
    });
    if (failed !== undefined) return { ended: failed } as Ended;
  } else if (deliveries !== undefined) {
    await step.apply(join(step.view(), { deliveries }));
  }
  if (!intake.opensTurn && activeTurnIdOf(step.view().projection) === undefined) {
    return { ended: { next: null, session: step.session } } as Ended;
  }
  return turn;
}

/**
 * `session.clear()`: the machine withdraws what the cleared history asked, and history empties.
 * The control is a delivery, applied in the same commit as the clear.
 */
async function clearContext(step: Step): Promise<StepResult> {
  const delivery = controlDeliveryFor(step.view(), step.config.controlDelivery);
  await step.apply(
    controlled(delivery, "clear", (cause) =>
      clear(step.view(), { cause, sessionId: step.session.sessionId }),
    ),
  );
  const cleared = discardClearedHumanInput({
    ...step.session,
    state: clearMemorySessionState(step.session.state),
  });
  return { next: null, session: replaceSessionHistory(cleared, []) };
}

/** The deliveries a step's input and the queue it took in carry, each once. */
function deliveriesOf(
  ...inputs: readonly (HarnessStepInput | undefined)[]
): HarnessStepInput["deliveries"] {
  const byId = new Map<string, NonNullable<HarnessStepInput["deliveries"]>[number]>();
  for (const delivery of inputs.flatMap((input) => input?.deliveries ?? [])) {
    if (!byId.has(delivery.deliveryId)) byId.set(delivery.deliveryId, delivery);
  }
  return byId.size === 0 ? undefined : [...byId.values()];
}

/** Whether the input carries user-facing turn input. */
function hasStepInput(input: HarnessStepInput | undefined): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.answers?.length ?? 0) > 0;
}

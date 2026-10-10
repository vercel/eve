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
  acceptHumanInput,
  admitApprovedWork,
  discardClearedHumanInput,
} from "#harness/hitl/index.js";
import {
  clear,
  controlDeliveryFor,
  controlled,
  join,
} from "#harness/session-machine/transitions.js";
import { activeTurnId, turnPosition } from "#harness/session-machine/view.js";
import { createStep, openTurn, type Step } from "#harness/step/context.js";
import { prepareTurnInput, settleRuntimeWork } from "#harness/step/intake.js";
import type {
  HarnessSession,
  StepFn,
  HarnessStepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import type { InstrumentationAttempt, InstrumentationStepScope } from "#instrumentation/runtime.js";
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
    let attemptScope: InstrumentationAttempt | undefined;
    const emit =
      instrumentation?.createHandleEvent({
        getAttemptScope: () => attemptScope,
        isFrameworkTool: (name) => step.frameworkToolNames.has(name),
        handleEvent: config.handleEvent,
        turnId: activeTurnId(turnPosition(live.read())),
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

    const runtime = await settleRuntimeWork(step, input);
    if (runtime === undefined) return { next: null, session: step.session };
    const intake = await acceptHumanInput(step, runtime.input, { takeQueued: !runtime.waited });
    if (intake.kind === "stop") return intake.result;
    const turn = await prepareTurnInput(step, intake.input, {
      consumedMessage: intake.consumedMessage,
    });
    // A delivery an earlier step queued, such as an answer that resolved approvals first, joins
    // with the input the queue carried it in.
    const deliveries = deliveriesOf(input, intake.input);
    if (intake.opensTurn) {
      const failed = await openTurn(step, {
        deliveries,
        input: [...turn.ephemeral, ...turn.messages],
        message: intake.message,
      });
      if (failed !== undefined) return failed;
    } else if (deliveries !== undefined) {
      // An answer joins the turn it resumes; between turns, it has nothing to join.
      await step.apply(join(step.view(), { deliveries }));
    }
    // Input that opened no turn and found none open, such as a stale answer eve dropped,
    // settled above and leaves nothing to run.
    if (!intake.opensTurn && step.view().projection.activeTurnId === undefined) {
      return { next: null, session: step.session };
    }
    await admitApprovedWork(step, intake.approved);

    return runModelStep(step, {
      approved: intake.approved,
      onResponse: (response) => handleStepResult(step, response),
      generation,
      setAttemptScope: (scope) => {
        attemptScope = scope;
      },
      turn,
    });
  }

  return runStep;
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
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

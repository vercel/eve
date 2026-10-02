import { contextStorage } from "#context/container.js";
import { ScheduleIdKey, StaticModelReferenceKey } from "#context/keys.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { GenerationSteering } from "#harness/generation-steering.js";
import { acceptHumanInput, runApprovedWork } from "#harness/human-input/index.js";
import { hasStepInput } from "#harness/input-requests.js";
import { compactHistory, replaceSessionHistory } from "#harness/model-call/compaction.js";
import { runModelStep } from "#harness/model-call/run.js";
import { handleStepResult } from "#harness/step/after-model.js";
import { createStep, openTurn, type Step } from "#harness/step/context.js";
import { prepareTurnInput, settleRuntimeWork } from "#harness/step/intake.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type {
  HarnessEmitFn,
  HarnessSession,
  StepFn,
  StepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import type { InstrumentationAttempt, InstrumentationStepScope } from "#instrumentation/runtime.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createContextClearedEvent, createSessionWaitingEvent } from "#protocol/message.js";
import { createHistoryViewPreparer } from "#shared/history-view.js";
import { clearMemorySessionState } from "#shared/memory-state.js";

const environment = process.env.NODE_ENV ?? "unknown";
const eveVersion = resolveInstalledPackageInfo().version;

/**
 * Creates the harness step: one step of a session, backed by the AI SDK's `ToolLoopAgent`.
 *
 * A step settles what the runtime ran for a parked step and takes its delivery's answers, opens or
 * joins the turn, applies what those answers granted, then makes one model step and acts on its
 * response.
 */
export function createToolLoopHarness(config: ToolLoopHarnessConfig): StepFn {
  config.instrumentation?.installAiSdkWarningLogger();

  async function runStep(
    initialSession: Readonly<Parameters<StepFn>[0]>,
    input?: StepInput,
  ): Promise<StepResult> {
    const executeStep = async (scope?: InstrumentationStepScope<HarnessSession>) => {
      const current = scope?.session ?? initialSession;
      const generation = new GenerationSteering({
        abortSignal: config.abortSignal,
        steeringSignal: config.steeringSignal,
        outputStarted: getHarnessEmissionState(current.state).assistantOutputStarted,
      });
      try {
        return await executeStepBody(current, generation, input, scope);
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
    input: StepInput | undefined,
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
    const handleEvent =
      instrumentation?.createHandleEvent({
        getAttemptScope: () => attemptScope,
        handleEvent: config.handleEvent,
        turnId: activeTurnId(getHarnessEmissionState(initialSession.state)),
      }) ?? config.handleEvent;
    const emit: HarnessEmitFn | undefined =
      handleEvent === undefined
        ? undefined
        : async (event, messages) => {
            generation.beforeEvent(event);
            await handleEvent(event, messages);
          };
    const step = createStep({
      config,
      ctx,
      emit,
      instrumentation,
      prepareHistory,
      runStep,
      session: initialSession,
    });

    if (config.clearOnly === true) return clearContext(step);
    if (config.compactOnly === true) return compactHistory(step);

    const runtime = await settleRuntimeWork(step, input);
    if (runtime === undefined) return { next: null, session: step.session };
    const intake = await acceptHumanInput(step, input, runtime);
    if (intake.kind === "stop") return intake.result;
    const turn = await prepareTurnInput(step, intake.input, intake);
    if (intake.opensTurn) {
      const failed = await openTurn(step, {
        input: [...turn.ephemeral, ...turn.messages],
        message: intake.message,
        pending: intake.pending,
      });
      if (failed !== undefined) return failed;
    }
    runApprovedWork(step, intake.approved);

    return runModelStep(step, {
      onResponse: (response) => handleStepResult(step, response),
      approved: intake.approved,
      generation,
      // A child's caller and a schedule hear only the turn's real end, so a held turn's text
      // isn't posted as their reply. A person reads a root session.
      hidesHeldText: step.hasDelegatedCaller || ctx?.get(ScheduleIdKey) !== undefined,
      pending: intake.pending,
      setAttemptScope: (scope) => {
        attemptScope = scope;
      },
      turn,
    });
  }

  return runStep;
}

/** `session.clear()`: history and memory empty, and the session waits. */
async function clearContext(step: Step): Promise<StepResult> {
  const position = step.position();
  step.session = replaceSessionHistory(
    { ...step.session, state: clearMemorySessionState(step.session.state) },
    [],
  );
  await step.emit?.(
    createContextClearedEvent({
      sequence: position.sequence,
      sessionId: step.session.sessionId,
      turnId: activeTurnId(position),
    }),
  );
  await step.emit?.(createSessionWaitingEvent(getSessionUsage(step.session)));
  return { next: null, session: step.session };
}

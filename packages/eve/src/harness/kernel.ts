import { activeTurnIdOf } from "#protocol/session-projection.js";
import { type AlsContext, contextStorage } from "#context/container.js";
import { GenerationSteering } from "#harness/generation-steering.js";
import { compactHistory } from "#harness/compaction/step.js";
import { readTaskTable, takeTaskResults, writeTaskTable } from "#execution/tasks/table.js";
import { runModelStep } from "#harness/model-call/run.js";
import { withUsageSink } from "#harness/usage-sink.js";
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
  openDeferredApprovals,
  queueInput,
  settleHumanInput,
  turnInputOnly,
  withoutTurnInput,
} from "#harness/hitl/index.js";
import { blocked, hasQueuedTurnInput, park } from "#harness/step/park.js";
import {
  clear,
  controlDeliveryFor,
  controlled,
  join,
} from "#harness/session-machine/transitions.js";
import {
  committedEndingStep,
  endingStepKeys,
  turnPosition,
} from "#harness/session-machine/view.js";
import { createStep, failTurnForEffect, openTurn, type Step } from "#harness/step/context.js";
import { prepareTurnInput, settleRuntimeWork } from "#harness/step/intake.js";
import { settleTurn } from "#harness/step/after-model.js";
import { workingTaskIds } from "#execution/tasks/model-step.js";
import type {
  HarnessSession,
  StepFn,
  HarnessStepInput,
  StepResult,
  KernelConfig,
} from "#harness/types.js";
import type { InstrumentationStepScope } from "#instrumentation/runtime.js";
import { installedEveVersion } from "#runtime-env/package-info.js";
import { eventsOf } from "#harness/publication.js";
import { awaitsProviderToolResult } from "#harness/provider-tool-history.js";

const environment = process.env.NODE_ENV ?? "unknown";

export function createKernel(config: KernelConfig): StepFn {
  config.instrumentation?.installAiSdkWarningLogger();

  async function runStep(
    initialSession: Readonly<Parameters<StepFn>[0]>,
    input?: HarnessStepInput,
  ): Promise<StepResult> {
    const executeStep = async (scope?: InstrumentationStepScope<HarnessSession>) => {
      const current = scope?.session ?? initialSession;
      const ctx = contextStorage.getStore();
      if (ctx === undefined) throw new Error("A session step runs inside its session's context.");
      const live = stepProjection(ctx, current.state);
      const generation = new GenerationSteering({
        abortSignal: config.abortSignal,
        steeringSignal: config.steeringSignal,
        outputStarted: turnPosition(live.read()).assistantOutputStarted,
      });
      try {
        const result = await executeStepBody(ctx, current, generation, live, input, scope);
        return { ...result, session: saveProjection(result.session, live.read()) };
      } finally {
        generation.dispose();
      }
    };
    return (
      config.instrumentation?.runStep(
        {
          environment,
          eveVersion: installedEveVersion(),
          hasInput: hasStepInput(input),
          session: initialSession,
        },
        executeStep,
      ) ?? executeStep()
    );
  }

  async function executeStepBody(
    ctx: AlsContext,
    initialSession: HarnessSession,
    generation: GenerationSteering,
    live: StepProjection,
    input: HarnessStepInput | undefined,
    instrumentation: InstrumentationStepScope<HarnessSession> | undefined,
  ): Promise<StepResult> {
    const emit =
      instrumentation?.createHandleEvent({
        isFrameworkTool: (name) => step.frameworkToolNames.has(name),
        handleEvent: config.handleEvent,
      }) ?? config.handleEvent;
    const publish: Publish = async (publication, messages) => {
      const events = eventsOf(publication);
      for (const event of events) generation.beforeEvent(event);
      if (emit !== undefined) await emit(publication, messages);
      if (emit === undefined) live.record(publication);
    };
    const step = createStep({
      config,
      ctx,
      emit,
      instrumentation,
      live,
      publish,
      runStep,
      session: initialSession,
    });

    return await withUsageSink(publish, () => runStages(step, input, generation));
  }

  async function runStages(
    step: Step,
    input: HarnessStepInput | undefined,
    generation: GenerationSteering,
  ): Promise<StepResult> {
    if (config.clearOnly === true) return clearContext(step);
    if (config.compactOnly === true) return compactHistory(step);
    const ending = endingStepKeys(step.view());

    const runtime = await runtimeResults(step, input);
    if ("ended" in runtime) return runtime.ended;
    const answered = await answers(step, runtime);
    if ("ended" in answered) return answered.ended;
    const turn = await turnInput(step, input, answered);
    if ("ended" in turn) return turn.ended;
    const hookFailure = await failTurnForEffect(step);
    if (hookFailure !== undefined) return hookFailure;
    const stopped = await applyHumanDecisions(step, answered.decided);
    if (stopped !== undefined) return stopped;
    if (blocked(step.view(), step.session.state)) return park(step);
    if (hasQueuedTurnInput(step.view()) && !awaitsProviderToolResult(step.session.history)) {
      const prepared = answered.input && { ...answered.input, message: turn.message };
      await step.apply(queueInput(step.view(), turnInputOnly(prepared)));
      return { next: step.runStep, session: step.session };
    }
    const endsTurn = runtime.endsTurn || committedEndingStep(step.view(), ending);
    if (endsTurn && turn.messages.length === 0 && !hasQueuedTurnInput(step.view())) {
      const workingTasks = workingTaskIds(step.session);
      if (workingTasks.length > 0) {
        return {
          held: { kind: "tasks", taskIds: workingTasks },
          next: null,
          session: step.session,
        };
      }
      return settleTurn(step, { stepOutput: null });
    }
    return runModelStep(step, {
      generation,
      turn,
    });
  }

  return runStep;
}

interface Ended {
  readonly ended: StepResult;
}

async function runtimeResults(step: Step, input: HarnessStepInput | undefined) {
  const runtime = await settleRuntimeWork(step, input);
  if (runtime === undefined) return { ended: { next: null, session: step.session } } as Ended;
  await step.apply(openDeferredApprovals(step.view()));
  return runtime;
}

async function answers(
  step: Step,
  runtime: NonNullable<Awaited<ReturnType<typeof settleRuntimeWork>>>,
) {
  const intake = await admitHumanInput(step, runtime.input, { takeQueued: !runtime.waited });
  if (intake.kind === "stop") return { ended: intake.result } as Ended;
  const decided = await settleHumanInput(step, intake);
  let { input, message } = intake;
  if (
    decided.approved.length > 0 ||
    decided.settledApprovals ||
    (awaitsProviderToolResult(step.session.history) &&
      activeTurnIdOf(step.view().projection) !== undefined)
  ) {
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

async function turnInput(
  step: Step,
  input: HarnessStepInput | undefined,
  { input: received, intake, message }: Exclude<Awaited<ReturnType<typeof answers>>, Ended>,
) {
  const turn = await prepareTurnInput(step, received, { consumedMessage: intake.consumedMessage });
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

async function clearContext(step: Step): Promise<StepResult> {
  const delivery = controlDeliveryFor(step.view(), step.config.controlDelivery);
  await step.apply(controlled(delivery, "clear", (cause) => clear(step.view(), { cause })));
  const unread = takeTaskResults(readTaskTable(step.session.state)).table;
  return { next: null, session: writeTaskTable(step.session, unread) };
}

function deliveriesOf(
  ...inputs: readonly (HarnessStepInput | undefined)[]
): HarnessStepInput["deliveries"] {
  const byId = new Map<string, NonNullable<HarnessStepInput["deliveries"]>[number]>();
  for (const delivery of inputs.flatMap((input) => input?.deliveries ?? [])) {
    if (!byId.has(delivery.deliveryId)) byId.set(delivery.deliveryId, delivery);
  }
  return byId.size === 0 ? undefined : [...byId.values()];
}

function hasStepInput(input: HarnessStepInput | undefined): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.answers?.length ?? 0) > 0;
}

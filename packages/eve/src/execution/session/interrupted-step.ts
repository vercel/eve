import type { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { preserveStoppedTurnMessage } from "#execution/cancelled-model-call-batch.js";
import type { OrphanedLine } from "#execution/publish-session-events.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { interruptedAttemptNote, type InterruptedCall } from "#harness/interrupted-attempt.js";
import { createImportedHistoryMessages } from "#harness/messages.js";
import { supersede } from "#harness/session-machine/cascade.js";
import { rowOf, type Ref } from "#protocol/session-projection/tree.js";
import {
  applyTransition,
  commitTransitions,
  dropClosedRecords,
  saveTransition,
  sessionView,
} from "#harness/session-machine/commit.js";
import { currentProjection, saveSessionProjection } from "#harness/session-machine/current.js";
import {
  clearedByAttempt,
  fail,
  receive,
  stopInterruptedSteps,
} from "#harness/session-machine/transitions.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { failInterruptedControl } from "#harness/session-machine/deliveries.js";
import type {
  Commit,
  ControlDelivery,
  HarnessSession,
  HarnessStepInput,
  SessionPublication,
  SessionStateMap,
  StepResult,
} from "#harness/types.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { eventsOfLine } from "#protocol/session-lines.js";
import type { SessionOutcome } from "#protocol/session-events/families/session.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";

const log = createLogger("execution.interrupted-step");

export interface InterruptedAttempt {
  readonly since: number;
  readonly calls: ReadonlyMap<string, InterruptedCall>;
  readonly settledInteractions: ReadonlySet<string>;
  readonly sessionEnded: SessionOutcome | undefined;
  readonly cleared: boolean;
  readonly settledTurn?: { readonly failed: boolean; readonly text?: string };
}

export function readInterruptedAttempt(
  since: number,
  lines: readonly OrphanedLine[],
): InterruptedAttempt {
  const calls = new Map<string, { -readonly [K in keyof InterruptedCall]: InterruptedCall[K] }>();
  const replies = new Map<string, string>();
  const settledInteractions = new Set<string>();
  let sessionEnded: SessionOutcome | undefined;
  let cleared = false;
  let settledTurn: InterruptedAttempt["settledTurn"];
  const call = (callId: string) => {
    let found = calls.get(callId);
    if (found === undefined) calls.set(callId, (found = { name: "", started: false }));
    return found;
  };
  for (const { line, position } of lines) {
    if (!("facts" in line)) continue;
    for (const event of eventsOfLine(line, position, line.at)) {
      switch (event.type) {
        case "call.requested":
          Object.assign(call(event.data.callId), {
            input: event.data.input,
            name: event.data.capability.name,
          });
          break;
        case "call.started":
          call(event.data.callId).started = true;
          break;
        case "call.settled":
          call(event.data.callId).outcome = event.data.outcome;
          break;
        case "interaction.settled":
          settledInteractions.add(event.data.interactionId);
          break;
        case "content.completed":
          if (event.data.kind === "text" && typeof event.data.value === "string") {
            replies.set(event.data.partId, event.data.value);
          }
          break;
        case "turn.settled": {
          const text = (event.data.reply ?? []).flatMap((partId) => replies.get(partId) ?? []);
          settledTurn = {
            failed: event.data.outcome === "failed",
            ...(text.length > 0 && { text: text.join("\n\n") }),
          };
          break;
        }
        case "session.ended":
          sessionEnded = event.data.outcome;
          break;
        case "context.settled":
          if (event.data.kind === "clear" && event.data.outcome === "completed") cleared = true;
          break;
      }
    }
  }
  return { calls, cleared, sessionEnded, settledInteractions, settledTurn, since };
}

export async function recoverInterruptedStep(input: {
  readonly attempt: InterruptedAttempt;
  readonly ctx: ContextContainer;
  readonly publish: (
    publication: SessionPublication,
    session: HarnessSession,
  ) => Promise<HarnessSession>;
  readonly session: HarnessSession;
  readonly stepInput: HarnessStepInput | undefined;
  readonly admission: Commit;
  readonly control?: {
    readonly kind: "clear" | "compact";
    readonly delivery?: ControlDelivery;
  };
  readonly failed?: { readonly error: { readonly name?: string }; readonly stopped?: true };
}): Promise<
  | { readonly result: DurableStepResult }
  | { readonly session: HarnessSession; readonly stepInput: HarnessStepInput | undefined }
> {
  const { attempt, ctx } = input;
  let session = input.session;
  const publish = async (publication: SessionPublication) => {
    session = await input.publish(publication, session);
  };
  const view = () => sessionView(currentProjection(ctx), session.state);
  const closeAttempt = async (which: (ref: Ref, row: OpenRow) => boolean) => {
    const tables = currentProjection(ctx).view;
    const closures = supersede(
      tables,
      (ref) => {
        const row = rowOf(tables, ref.family, ref.id) as OpenRow | undefined;
        return row !== undefined && which(ref, row);
      },
      "step-interrupted",
    );
    if (closures.length > 0) await publish(closures);
  };
  const introduced = (row: OpenRow) => row.introducedAt >= attempt.since;
  const finish = (result: StepResult) => {
    const saved = saveSessionProjection(
      dropClosedRecords(
        reconcileSessionContinuationToken(ctx, result.session),
        currentProjection(ctx),
      ),
      ctx,
    );
    return {
      result: resolveSessionStepResult({ ...result, session: saved }, serializeContext(ctx)),
    };
  };

  if (attempt.sessionEnded !== undefined) {
    return finish({
      next: {
        done: true,
        isError: attempt.sessionEnded === "failed",
        output: attempt.settledTurn?.text ?? "",
      },
      session,
    });
  }
  if (input.control !== undefined) {
    await closeAttempt(
      ({ family }, row) => (family === "run" || family === "change") && introduced(row),
    );
    if (attempt.cleared) {
      session = saveTransition(session, clearedByAttempt(view()));
    }
    const { delivery, kind } = input.control;
    const status =
      delivery === undefined
        ? undefined
        : currentProjection(ctx).view.deliveries[delivery.deliveryId]?.status;
    if (delivery !== undefined && status !== "settled") {
      await publish(failInterruptedControl(delivery, kind, { recorded: status !== undefined }));
    }
    return finish({ next: null, session });
  }

  const { settledTurn } = attempt;
  if (settledTurn !== undefined && activeTurnIdOf(currentProjection(ctx)) === undefined) {
    session = changeHistory(session, {
      append: createImportedHistoryMessages(input.stepInput?.history ?? []),
    });
    session = await preserveStoppedTurnMessage(ctx, session, input.stepInput);
    if (settledTurn.text !== undefined) {
      session = changeHistory(session, {
        append: [{ content: settledTurn.text, role: "assistant" }],
      });
    }
    return finish({
      next: null,
      session,
      settledTurn: { isError: settledTurn.failed, output: settledTurn.text ?? "" },
    });
  }

  const stop = stopInterruptedSteps(view(), attempt);
  const asked = new Set(
    view()
      .turn.suspended.filter((step) => !stop.turn.suspended.includes(step))
      .flatMap((step) => step.requests.map((request) => request.interactionId)),
  );
  await closeAttempt(({ family, id }, row) => {
    switch (family) {
      case "run":
      case "change":
        return introduced(row);
      case "call":
        return (
          row.taskId === undefined && (introduced(row) || attempt.calls.get(id)?.started === true)
        );
      case "interaction":
        return !view().relayedRequestIds.has(id) && (introduced(row) || asked.has(id));
      default:
        return false;
    }
  });

  const turnId = activeTurnIdOf(currentProjection(ctx));
  const interruptions = turnId === undefined ? 0 : turnInterruptions(session.state, turnId) + 1;
  session = saveTransition(session, stop);
  const note = interruptedAttemptNote(attempt.calls);
  if (note !== undefined) session = changeHistory(session, { append: [note] });
  const stopped = input.failed?.stopped === true;
  if (stopped || (input.failed === undefined && interruptions <= MAX_TURN_INTERRUPTIONS)) {
    const { settledInteractions } = attempt;
    const answers = input.stepInput?.answers?.filter(
      (answer) => !settledInteractions.has(answer.interactionId),
    );
    return {
      session:
        turnId === undefined ? session : withTurnInterruptions(session, turnId, interruptions),
      stepInput: input.stepInput === undefined ? undefined : { ...input.stepInput, answers },
    };
  }

  if (input.admission.length > 0) await publish(input.admission);
  const deliveries = (input.stepInput?.deliveries ?? []).filter(
    ({ deliveryId }) => currentProjection(ctx).view.deliveries[deliveryId]?.status === "admitted",
  );
  if (deliveries.length > 0) await publish(commitTransitions([receive(view(), { deliveries })]));
  const failing = activeTurnIdOf(currentProjection(ctx));
  if (failing === undefined) return finish({ next: null, session });
  session = await preserveStoppedTurnMessage(ctx, session, input.stepInput);
  const failure =
    input.failed === undefined
      ? {
          code: "STEP_INTERRUPTED",
          details: { errorId: createErrorId() },
          message: "This turn was interrupted too many times to continue.",
        }
      : {
          code: "TURN_FAILED",
          details: { errorId: createErrorId() },
          message: "This turn failed before it finished. Send another message to continue.",
        };
  log.error("turn failed", {
    code: failure.code,
    errorName: input.failed?.error.name,
    errorId: failure.details.errorId,
    sessionId: session.sessionId,
    turnId: failing,
  });
  session = await applyTransition(session, fail(view(), failure), publish);
  return finish({ next: null, session, settledTurn: { isError: true, output: failure.message } });
}

interface OpenRow {
  readonly introducedAt: number;
  readonly taskId?: string;
}

const INTERRUPTIONS_STATE_KEY = "eve.turn-interruptions";

export const MAX_TURN_INTERRUPTIONS = 3;

function turnInterruptions(state: SessionStateMap | undefined, turnId: string): number {
  const stored = state?.[INTERRUPTIONS_STATE_KEY] as
    | { readonly turnId: string; readonly count: number }
    | undefined;
  return stored?.turnId === turnId ? stored.count : 0;
}

function withTurnInterruptions(
  session: HarnessSession,
  turnId: string,
  count: number,
): HarnessSession {
  return { ...session, state: { ...session.state, [INTERRUPTIONS_STATE_KEY]: { count, turnId } } };
}

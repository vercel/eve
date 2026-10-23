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
  dropClosedRecords,
  saveTransition,
  sessionView,
} from "#harness/session-machine/commit.js";
import { currentProjection, saveSessionProjection } from "#harness/session-machine/current.js";
import { fail, receive, stopInterruptedSteps } from "#harness/session-machine/transitions.js";
import { replaceSessionHistory } from "#harness/compaction/step.js";
import { controlAdmitted, fact } from "#harness/facts.js";
import type {
  ControlDelivery,
  HarnessSession,
  HarnessStepInput,
  SessionStateMap,
  StepResult,
} from "#harness/types.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { summarizeFailure } from "#execution/failure-summary.js";
import { eventsOfLine } from "#protocol/session-lines.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { SessionOutcome } from "#protocol/session-events/families/session.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";

const log = createLogger("execution.interrupted-step");

/** What an interrupted earlier attempt of a turn step published past the step's checkpoint. */
export interface InterruptedAttempt {
  /** The first line it wrote. */
  readonly since: number;
  readonly calls: ReadonlyMap<string, InterruptedCall>;
  /** The interactions it settled, such as approvals it applied. */
  readonly settledInteractions: ReadonlySet<string>;
  /** It ended the session. */
  readonly sessionEnded: SessionOutcome | undefined;
  /** It cleared the history. */
  readonly cleared: boolean;
  /** It settled a turn: the last one, with the reply's text. */
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

/**
 * Recovers a turn step whose earlier attempt published past the checkpoint. The orphaned lines
 * are already folded into the step's projection, so what the step writes follows them.
 *
 * What the attempt left open closes as superseded, and the step runs again from its checkpoint:
 * the calls the attempt started never run again, and the model reads which may have run. When
 * the attempt ended the session or settled its turn, nothing is left to run. The ending keeps
 * its outcome and recorded reply output; a settled turn keeps its input and reply in history.
 * A step that failed every attempt (`failed`) fails the turn with the error its last attempt
 * threw instead, and a turn interrupted too often fails too.
 *
 * Returns the step's result when it ends here, or the session the step runs on with. Its own
 * new facts use normal reactions; facts already recorded are only adopted.
 */
export async function recoverInterruptedStep(input: {
  readonly attempt: InterruptedAttempt;
  readonly ctx: ContextContainer;
  readonly publish: (
    events: SessionEvent | readonly SessionEvent[],
    session: HarnessSession,
  ) => Promise<HarnessSession>;
  readonly session: HarnessSession;
  readonly stepInput: HarnessStepInput | undefined;
  /** Admission facts no attempt wrote, which a step that ends here must still write. */
  readonly admission: readonly SessionEvent[];
  /** The control the step applies, with the delivery it arrived as. */
  readonly control?: {
    readonly kind: "clear" | "compact";
    readonly delivery?: ControlDelivery;
  };
  /** The error the step's last attempt threw, when every attempt failed. */
  readonly failed?: { readonly error: unknown };
}): Promise<
  | { readonly result: DurableStepResult }
  | { readonly session: HarnessSession; readonly stepInput: HarnessStepInput | undefined }
> {
  const { attempt, ctx } = input;
  let session = input.session;
  const publish = async (events: SessionEvent | readonly SessionEvent[]) => {
    session = await input.publish(events, session);
  };
  const view = () => sessionView(currentProjection(ctx), session.state);
  /** Closes, as superseded, what `which` selects of the open work the attempt introduced. */
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
    // A control applies once: a clear the attempt finished empties history now, and a control
    // it left unsettled settles failed rather than run again.
    if (attempt.cleared) {
      const cleared = saveTransition(session, {
        clearsHistory: true,
        events: [],
        signIns: [],
        turn: { remembered: view().turn.remembered, suspended: [] },
      });
      session = replaceSessionHistory(cleared, []);
    }
    const { delivery, kind } = input.control;
    const status =
      delivery === undefined
        ? undefined
        : currentProjection(ctx).view.deliveries[delivery.deliveryId]?.status;
    if (delivery !== undefined && status !== "settled") {
      await publish([
        ...(status === undefined ? [controlAdmitted(delivery, kind)] : []),
        fact("delivery.settled", {
          deliveryId: delivery.deliveryId,
          outcome: "failed",
          reason: `${kind}-interrupted`,
        }),
      ]);
    }
    return finish({ next: null, session });
  }

  const { settledTurn } = attempt;
  if (settledTurn !== undefined && activeTurnIdOf(currentProjection(ctx)) === undefined) {
    // The checkpoint predates the step, so the history its input imported is not in it yet.
    session = {
      ...session,
      history: [
        ...session.history,
        ...createImportedHistoryMessages(input.stepInput?.history ?? []),
      ],
    };
    session = await preserveStoppedTurnMessage(ctx, session, input.stepInput);
    if (settledTurn.text !== undefined) {
      session = {
        ...session,
        history: [...session.history, { content: settledTurn.text, role: "assistant" }],
      };
    }
    return finish({
      next: null,
      session,
      settledTurn: { isError: settledTurn.failed, output: settledTurn.text ?? "" },
    });
  }

  // A step whose answers the attempt applied, or whose calls it started, stops, and what it
  // still asks closes with it. Tasks keep working, and requests relayed for them stay.
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
  if (note !== undefined) session = { ...session, history: [...session.history, note] };
  if (input.failed === undefined && interruptions <= MAX_TURN_INTERRUPTIONS) {
    // The answers the attempt applied leave the input.
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

  // The turn fails with its input kept, as if the step had stopped where it began.
  if (input.admission.length > 0) await publish(input.admission);
  const deliveries = (input.stepInput?.deliveries ?? []).filter(
    ({ deliveryId }) => currentProjection(ctx).view.deliveries[deliveryId]?.status === "admitted",
  );
  if (deliveries.length > 0) await publish(receive(view(), { deliveries }).events);
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
      : summarizeFailure(input.failed.error, "STEP_FAILED");
  log.error("turn failed", {
    code: failure.code,
    errorId: failure.details.errorId,
    sessionId: session.sessionId,
    turnId: failing,
  });
  session = await applyTransition(session, fail(view(), failure), publish);
  return finish({ next: null, session, settledTurn: { isError: true, output: failure.message } });
}

/** What closing reads of an open row. */
interface OpenRow {
  readonly introducedAt: number;
  readonly taskId?: string;
}

const INTERRUPTIONS_STATE_KEY = "eve.turn-interruptions";

/** How many interrupted steps one turn runs again before it fails. */
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

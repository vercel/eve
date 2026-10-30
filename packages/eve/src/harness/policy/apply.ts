import { workingTaskIds } from "#execution/tasks/model-step.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { fail } from "#harness/session-machine/transitions.js";
import type { Step } from "#harness/step/context.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { StepResult } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type { JsonValue } from "#shared/json.js";
import { nativeNext, nativePolicy } from "./native.js";
import { force, type ModelStep, type Next, type PolicyContext } from "./policy.js";

// The kernel side of a policy: eve asks it where it decides, then applies the answer through
// the rules no policy can change. A turn doesn't end while its tasks work, a note needs to say
// something, a turn gets a bounded number of notes, and a failing policy fails the turn with a
// message that doesn't reveal why.

const log = createLogger("harness.policy");

/** How many notes a policy can add to one turn. At the cap, eve's own loop decides. */
export const MAX_CONTINUATIONS = 3;

/** Marks the notes a policy adds, with the turn they continued. */
const NOTE_KEY = "eve.program";

const HARNESS_FAILED = {
  code: "HARNESS_FAILED",
  message: "The agent's harness failed.",
} as const;

/** Ends the turn with a policy's output, through eve's own checks. */
export type Settle = (step: Step, output: JsonValue | null) => Promise<StepResult>;

/** What eve knows where it decides, beyond the session itself. */
interface Decision {
  readonly lastStep: ModelStep;
  readonly unread: boolean;
}

function policyContext(step: Step, decision: Decision): PolicyContext {
  const turnId = step.position().turnId;
  return {
    signal: step.config.abortSignal,
    tasks: { working: workingTaskIds(step.session) },
    turn: {
      continuations: continuationsOf(step.session.history, turnId),
      id: turnId,
      lastStep: decision.lastStep,
      unread: decision.unread,
    },
  };
}

/** Asks the session's policy what the turn does after a model step, and does it. */
export async function decideAfterModel(
  step: Step,
  decision: Decision,
  settle: Settle,
): Promise<StepResult> {
  const ctx = policyContext(step, decision);
  let next: Next;
  try {
    // A policy that leaves `next` out, or answers nothing, leaves the decision to eve.
    next = (await force((step.config.policy ?? nativePolicy)(ctx).next)) ?? nativeNext(ctx);
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    log.error("the harness policy threw; failing the turn", { error, turnId: ctx.turn?.id });
    return await failPolicy(step);
  }
  return await applyNext(step, ctx, next, settle);
}

async function applyNext(
  step: Step,
  ctx: PolicyContext,
  next: Next,
  settle: Settle,
): Promise<StepResult> {
  if ("model" in next) {
    const note = next.model.note;
    if (note === undefined) {
      if (ctx.turn?.unread !== true) {
        return await invalid(step, "called the model again with nothing new for it to read");
      }
      return { next: step.runStep, session: step.session };
    }
    if (typeof note !== "string" || note.trim().length === 0) {
      return await invalid(step, "continued with an empty note");
    }
    if (ctx.turn!.continuations >= MAX_CONTINUATIONS) {
      return await applyNext(step, ctx, nativeNext(ctx), settle);
    }
    step.session = changeHistory(step.session, {
      append: [
        createFrameworkUserMessage("execution.continuation", note, { [NOTE_KEY]: ctx.turn!.id }),
      ],
    });
    return { next: step.runStep, session: step.session };
  }
  if ("settle" in next) {
    // No turn ends while its tasks work: the session waits for one to settle, then calls the
    // model again in the same turn.
    if (ctx.tasks.working.length > 0) {
      return {
        held: { kind: "tasks", taskIds: ctx.tasks.working },
        next: null,
        session: step.session,
      };
    }
    return await settle(step, next.settle.output);
  }
  return await invalid(step, "returned a next step eve doesn't know");
}

async function invalid(step: Step, reason: string): Promise<StepResult> {
  log.error(`the harness policy ${reason}; failing the turn`, {
    turnId: step.position().turnId,
  });
  return await failPolicy(step);
}

async function failPolicy(step: Step): Promise<StepResult> {
  step.session = { ...clearTurnClientContextState(step.session), outputSchema: undefined };
  await step.apply(fail(step.view(), HARNESS_FAILED));
  return {
    next: null,
    session: step.session,
    settledTurn: { isError: true, output: HARNESS_FAILED.message },
  };
}

/** The notes policies added to this turn, which compaction may have summarized away. */
function continuationsOf(history: readonly HarnessModelMessage[], turnId: string): number {
  return history.filter(
    (message) =>
      message.role === "user" &&
      message.kind === "execution.continuation" &&
      message.metadata?.[NOTE_KEY] === turnId,
  ).length;
}

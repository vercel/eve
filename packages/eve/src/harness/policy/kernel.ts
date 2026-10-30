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
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { nativeHistory, nativeNext, nativePolicy } from "./native.js";
import {
  force,
  type HistorySize,
  type ModelStep,
  type Next,
  type Policy,
  type PolicyContext,
  type Summarize,
} from "./policy.js";

// The kernel side of a policy: eve asks it where it decides, then applies the answer through
// the rules no policy can change. A turn doesn't end while its tasks work, a note needs to say
// something, a turn gets a bounded number of notes, a history passes eve's checks, and a failing
// policy fails with a message that doesn't reveal why. A field the policy leaves out is eve's.

const log = createLogger("harness.program");

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
  readonly lastStep?: ModelStep;
  /** The history the decision is about, where it isn't the session's: a request's. */
  readonly history?: readonly HarnessModelMessage[];
  readonly size?: HistorySize;
  readonly compact?: true;
  readonly summarize?: Summarize;
}

const NO_SUMMARIZER: Summarize = () => {
  throw new Error("eve summarizes the history only where it asks for the history.");
};

function policyContext(step: Step, decision: Decision): PolicyContext {
  const turnId = activeTurnIdOf(step.view().projection);
  const history = decision.history ?? step.session.history;
  return {
    ...(decision.compact !== undefined && { compact: decision.compact }),
    history,
    ...(decision.size !== undefined && { size: decision.size }),
    summarize: decision.summarize ?? NO_SUMMARIZER,
    signal: step.config.abortSignal,
    tasks: { working: workingTaskIds(step.session) },
    turn:
      turnId === undefined
        ? null
        : {
            continuations: continuationsOf(step.session.history, turnId),
            id: turnId,
            ...(decision.lastStep !== undefined && { lastStep: decision.lastStep }),
            unread: history.at(-1)?.role === "tool",
          },
  };
}

function policyOf(step: Step): Policy {
  return step.config.policy ?? nativePolicy;
}

/** Asks the session's policy what the turn does after a model step, and does it. */
export async function decideAfterModel(
  step: Step,
  lastStep: ModelStep,
  settle: Settle,
): Promise<StepResult> {
  const ctx = policyContext(step, { lastStep });
  let next: Next;
  try {
    next = (await force(policyOf(step)(ctx).next)) ?? nativeNext(ctx);
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

/**
 * The history the session's policy says the model reads about the past, or eve's own when it
 * leaves that out. A policy that throws fails with a message that doesn't reveal why; a failure of
 * eve's summarizer is its own.
 */
export async function policyHistory(
  step: Step,
  input: {
    readonly messages: readonly HarnessModelMessage[];
    readonly size: HistorySize;
    readonly compact?: true;
    readonly summarize: Summarize;
  },
): Promise<readonly HarnessModelMessage[]> {
  const failures = new WeakSet<object>();
  const summarize: Summarize = async (history, options) => {
    try {
      return await input.summarize(history, options);
    } catch (error) {
      if (typeof error === "object" && error !== null) failures.add(error);
      throw error;
    }
  };
  const { compaction } = step.session;
  const options = {
    threshold: compaction.threshold,
    ...(compaction.thresholdPercent !== undefined && {
      thresholdPercent: compaction.thresholdPercent,
    }),
  };
  const ctx = policyContext(step, {
    ...(input.compact !== undefined && { compact: input.compact }),
    history: input.messages,
    size: input.size,
    summarize,
  });
  try {
    return (await force(policyOf(step)(ctx).history)) ?? (await nativeHistory(ctx, options));
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    if (typeof error === "object" && error !== null && failures.has(error)) throw error;
    log.error("the harness policy's history threw", { error, turnId: ctx.turn?.id });
    throw new Error(HARNESS_FAILED.message, { cause: error });
  }
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

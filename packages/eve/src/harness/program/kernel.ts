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
import { nativeHistory, nativeNext, nativeProgram } from "./native.js";
import {
  force,
  type HistorySize,
  type ModelStep,
  type Next,
  type Program,
  type ProgramContext,
  type Summarize,
} from "./program.js";

// The kernel side of a program: eve asks it where it decides, then applies the answer through
// the rules no program can change. A turn doesn't end while its tasks work, a note needs to say
// something, a turn gets a bounded number of notes, a history passes eve's checks, and a failing
// program fails with a message that doesn't reveal why. A field the program leaves out is eve's.

const log = createLogger("harness.program");

/** How many notes a program can add to one turn. At the cap, eve's own loop decides. */
export const MAX_CONTINUATIONS = 3;

/** Marks the notes a program adds, with the turn they continued. */
const NOTE_KEY = "eve.program";

const PROGRAM_FAILED = {
  code: "PROGRAM_FAILED",
  message: "The agent's program failed.",
} as const;

/** Ends the turn with a program's output, through eve's own checks. */
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

function programContext(step: Step, decision: Decision): ProgramContext {
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

function programOf(step: Step): Program {
  return step.config.program ?? nativeProgram;
}

/** Asks the session's program what the turn does after a model step, and does it. */
export async function decideAfterModel(
  step: Step,
  lastStep: ModelStep,
  settle: Settle,
): Promise<StepResult> {
  const ctx = programContext(step, { lastStep });
  let next: Next;
  try {
    next = (await force(programOf(step)(ctx).next)) ?? nativeNext(ctx);
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    log.error("the session program threw; failing the turn", { error, turnId: ctx.turn?.id });
    return await failProgram(step);
  }
  return await applyNext(step, ctx, next, settle);
}

async function applyNext(
  step: Step,
  ctx: ProgramContext,
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
 * The history the session's program says the model reads about the past, or eve's own when it
 * leaves that out. A program that throws fails with a message that doesn't reveal why; a failure of
 * eve's summarizer is its own.
 */
export async function programHistory(
  step: Step,
  input: {
    readonly messages: readonly HarnessModelMessage[];
    readonly size: HistorySize;
    readonly compact?: true;
    readonly summarize: Summarize;
    /** The agent's compaction strategy, which keeps the history instead of the program. */
    readonly history?: (ctx: ProgramContext) => Promise<readonly HarnessModelMessage[] | undefined>;
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
  const ctx = programContext(step, {
    ...(input.compact !== undefined && { compact: input.compact }),
    history: input.messages,
    size: input.size,
    summarize,
  });
  // The agent's own strategy: its errors are the author's to read.
  if (input.history !== undefined) return (await input.history(ctx)) ?? input.messages;
  try {
    return (await force(programOf(step)(ctx).history)) ?? (await nativeHistory(ctx, options));
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    if (typeof error === "object" && error !== null && failures.has(error)) throw error;
    log.error("the session program's history threw", { error, turnId: ctx.turn?.id });
    throw new Error(PROGRAM_FAILED.message, { cause: error });
  }
}

async function invalid(step: Step, reason: string): Promise<StepResult> {
  log.error(`the session program ${reason}; failing the turn`, {
    turnId: step.position().turnId,
  });
  return await failProgram(step);
}

async function failProgram(step: Step): Promise<StepResult> {
  step.session = { ...clearTurnClientContextState(step.session), outputSchema: undefined };
  await step.apply(fail(step.view(), PROGRAM_FAILED));
  return {
    next: null,
    session: step.session,
    settledTurn: { isError: true, output: PROGRAM_FAILED.message },
  };
}

/** The notes programs added to this turn, which compaction may have summarized away. */
function continuationsOf(history: readonly HarnessModelMessage[], turnId: string): number {
  return history.filter(
    (message) =>
      message.role === "user" &&
      message.kind === "execution.continuation" &&
      message.metadata?.[NOTE_KEY] === turnId,
  ).length;
}

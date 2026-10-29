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
import type { ContextContainer } from "#context/container.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { manifestValues } from "#reactions/bundle.js";
import type { ValueReaction } from "#reactions/reaction.js";
import { authoredProgram } from "./authored.js";
import { checkHistory } from "./check.js";
import { nativeNext, nativeProgram } from "./native.js";
import { SessionIdKey } from "#context/keys.js";
import type { Memo } from "#dynamic/definition.js";
import { programScope, withMemos } from "#reactions/runner.js";
import {
  type Compaction,
  continuationsOf,
  force,
  NOTE_KEY,
  type Lazy,
  type Plan,
  type ModelStep,
  type Next,
  type ProgramContext,
} from "./program.js";

// The kernel side of a program: eve asks it where it decides, then applies the answer through
// the rules no program can change. A turn doesn't end while its tasks work, a note needs to say
// something, a turn gets a bounded number of notes, a history passes eve's checks, and a failing
// program fails with a message that doesn't reveal why. A field the program leaves out is eve's.

const log = createLogger("harness.program");

/** How many notes a program can add to one turn. At the cap, eve's own loop decides. */
export const MAX_CONTINUATIONS = 3;

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
  readonly compaction?: Compaction;
}

function programContext(step: Step, decision: Decision, memo: Memo): ProgramContext {
  const turnId = activeTurnIdOf(step.view().projection);
  const history = decision.history ?? step.session.history;
  const container = step.ctx as ContextContainer | undefined;
  return {
    ...(decision.compaction !== undefined && { compaction: decision.compaction }),
    history,
    manifest: async () => (container === undefined ? [] : await manifestValues(container)),
    memo,
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

/**
 * Evaluates the session's program for one decision, and forces the field it decides. Each decision
 * has its own memos, which keep what its latest evaluation used, as a dynamic value's do.
 */
async function evaluate<T>(
  step: Step,
  input: {
    readonly decision: "agent" | "history" | "next";
    readonly context: Decision;
    readonly field: (plan: Plan, ctx: ProgramContext) => Lazy<T> | undefined;
  },
): Promise<{ readonly ctx: ProgramContext; readonly value: T | undefined }> {
  const container = step.ctx as ContextContainer | undefined;
  let ctx: ProgramContext | undefined;
  const run = async (memo: Memo) => {
    ctx = programContext(step, input.context, memo);
    const program = step.config.program ?? authoredProgram(container) ?? nativeProgram;
    return await force(input.field(program(ctx), ctx));
  };
  if (container === undefined || !container.has(SessionIdKey)) {
    const value = await run(() => {
      throw new Error(
        "ctx.memo keeps what it learns in the session's state, which this step doesn't carry.",
      );
    });
    return { ctx: ctx!, value };
  }
  const { result } = await withMemos(
    container,
    {
      abortSignal: step.config.abortSignal,
      label: "the session program",
      scope: programScope(input.decision),
    },
    run,
  );
  return { ctx: ctx!, value: result };
}

/** Asks the session's program what the turn does after a model step, and does it. */
export async function decideAfterModel(
  step: Step,
  lastStep: ModelStep,
  settle: Settle,
): Promise<StepResult> {
  let decided: { readonly ctx: ProgramContext; readonly value: Next | undefined };
  try {
    decided = await evaluate(step, {
      context: { lastStep },
      decision: "next",
      field: (plan, ctx) => plan.next ?? (() => nativeNext(ctx)),
    });
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    log.error("the session program threw; failing the turn", {
      error,
      turnId: step.position().turnId,
    });
    return await failProgram(step);
  }
  const { ctx, value } = decided;
  return await applyNext(step, ctx, value ?? nativeNext(ctx), settle);
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
 * The dynamic values the session's program makes the agent from, before a model call that reads
 * `conversation`. Throws {@link ProgramFailedError} when the program throws.
 */
export async function programValues(
  step: Step,
  conversation: readonly HarnessModelMessage[],
): Promise<readonly ValueReaction[]> {
  try {
    const { value } = await evaluate(step, {
      context: { history: conversation },
      decision: "agent",
      field: (plan, ctx) => plan.agent ?? ctx.manifest,
    });
    return value ?? [];
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    log.error("the session program's agent threw", { error, turnId: step.position().turnId });
    throw new ProgramFailedError(error);
  }
}

/** A program threw where eve can't fail the turn itself; the cause stays out of the message. */
export class ProgramFailedError extends Error {
  override readonly name = "ProgramFailedError";
  readonly code = PROGRAM_FAILED.code;
  constructor(cause: unknown) {
    super(PROGRAM_FAILED.message, { cause });
  }
}

/**
 * The history the session's program keeps where eve has to shrink it, inside the change eve
 * opened. eve's own compaction's result applies as it is, and its failures are its own; anything
 * else the program returns is checked first, and a program that throws fails the change with a
 * message that doesn't reveal why.
 */
export async function programHistory(
  step: Step,
  input: {
    readonly messages: readonly HarnessModelMessage[];
    readonly reason: Compaction["reason"];
    readonly limit: number;
    readonly native: (history: HarnessModelMessage[]) => Promise<HarnessModelMessage[]>;
  },
): Promise<HarnessModelMessage[]> {
  const natives = new WeakSet<object>();
  const failures = new WeakSet<object>();
  const compaction: Compaction = {
    native: async (history) => {
      try {
        const compacted = await input.native([...history]);
        natives.add(compacted);
        return compacted;
      } catch (error) {
        if (typeof error === "object" && error !== null) failures.add(error);
        throw error;
      }
    },
    reason: input.reason,
  };
  let history: readonly HarnessModelMessage[] | undefined;
  try {
    ({ value: history } = await evaluate(step, {
      context: { compaction, history: input.messages },
      decision: "history",
      field: (plan, ctx) => plan.history ?? (() => compaction.native(ctx.history)),
    }));
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    if (typeof error === "object" && error !== null && failures.has(error)) throw error;
    log.error("the session program's history threw", { error, turnId: step.position().turnId });
    throw new ProgramFailedError(error);
  }
  if (history === undefined) return [...input.messages];
  if (natives.has(history)) return history as HarnessModelMessage[];
  return checkHistory(input.messages, history, {
    automatic: input.reason === "automatic",
    limit: input.limit,
  });
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

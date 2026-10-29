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
import { checkHistory } from "./check.js";
import { nativeNext, nativeProgram } from "./native.js";
import {
  type Compaction,
  force,
  type ModelStep,
  type Next,
  type Program,
  type ProgramContext,
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
  readonly compaction?: Compaction;
}

function programContext(step: Step, decision: Decision): ProgramContext {
  const turnId = activeTurnIdOf(step.view().projection);
  const history = decision.history ?? step.session.history;
  const container = step.ctx as ContextContainer | undefined;
  return {
    ...(decision.compaction !== undefined && { compaction: decision.compaction }),
    history,
    manifest: async () => (container === undefined ? [] : await manifestValues(container)),
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
 * The dynamic values the session's program makes the agent from, before a model call that reads
 * `conversation`. Throws {@link ProgramFailedError} when the program throws.
 */
export async function programValues(
  step: Step,
  conversation: readonly HarnessModelMessage[],
): Promise<readonly ValueReaction[]> {
  const ctx = programContext(step, { history: conversation });
  try {
    return (await force(programOf(step)(ctx).agent ?? ctx.manifest)) ?? [];
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    log.error("the session program's agent threw", { error, turnId: ctx.turn?.id });
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
  const ctx = programContext(step, { compaction, history: input.messages });
  let history: readonly HarnessModelMessage[] | undefined;
  try {
    history = await force(programOf(step)(ctx).history ?? (() => compaction.native(ctx.history)));
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    if (typeof error === "object" && error !== null && failures.has(error)) throw error;
    log.error("the session program's history threw", { error, turnId: ctx.turn?.id });
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

/** The notes programs added to this turn, which compaction may have summarized away. */
function continuationsOf(history: readonly HarnessModelMessage[], turnId: string): number {
  return history.filter(
    (message) =>
      message.role === "user" &&
      message.kind === "execution.continuation" &&
      message.metadata?.[NOTE_KEY] === turnId,
  ).length;
}

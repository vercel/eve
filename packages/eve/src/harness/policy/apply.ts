import { workingTaskIds } from "#execution/tasks/model-step.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { fail } from "#harness/session-machine/transitions.js";
import type { Step } from "#harness/step/context.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { StepResult } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ContextContainer } from "#context/container.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import { authoredPolicy } from "./authored.js";
import { failPolicy, invalid, HARNESS_FAILED } from "./failure.js";
import { fact, turnSettled } from "#harness/facts.js";
import { failTurnForReaction, prepareModelCall } from "#harness/step/context.js";
import type { TurnInput } from "#harness/step/intake.js";
import { commitTurnInput, previewPrompt, type Prompt } from "#harness/step/prompt.js";
import { defineJsonSchema } from "#tools/schema.js";
import { nativeHistory, nativeNext, nativePolicy } from "./native.js";
import { SessionIdKey } from "#context/keys.js";
import type { Memo } from "#dynamic/definition.js";
import { policyScope, withMemos } from "#reactions/runner.js";
import {
  countNote,
  notesAdded,
  force,
  NOTE_KEY,
  type Lazy,
  type Plan,
  type ModelStep,
  type Next,
  type HistorySize,
  type Policy,
  type PolicyContext,
  type Summarize,
} from "./policy.js";

// The kernel side of a policy: eve asks it where it decides, then applies the answer through
// the rules no policy can change. A turn doesn't end while its tasks work, a note needs to say
// something, a turn gets a bounded number of notes, a history passes eve's checks, and a failing
// policy fails with a message that doesn't reveal why. A field the policy leaves out is eve's.

const log = createLogger("harness.policy");

/** How many notes a policy can add to one turn. At the cap, eve's own loop decides. */
export const MAX_CONTINUATIONS = 3;

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

function policyContext(step: Step, decision: Decision, memo: Memo): PolicyContext {
  const turnId = activeTurnIdOf(step.view().projection);
  const history = decision.history ?? step.session.history;
  return {
    ...(decision.compact !== undefined && { compact: decision.compact }),
    history,
    ...(decision.size !== undefined && { size: decision.size }),
    summarize: decision.summarize ?? NO_SUMMARIZER,
    memo,
    signal: step.config.abortSignal,
    tasks: { working: workingTaskIds(step.session) },
    turn:
      turnId === undefined
        ? null
        : {
            continuations: notesAdded(step.session.state, turnId),
            id: turnId,
            ...(decision.lastStep !== undefined && { lastStep: decision.lastStep }),
            // A step that made no calls read the results before it; a delivered reply replaced them.
            unread: history.at(-1)?.role === "tool" && (decision.lastStep?.madeCalls ?? true),
          },
  };
}

/**
 * Evaluates the session's policy for one decision, and forces the field it decides. Each decision
 * has its own memos, which keep what its latest evaluation used, as a dynamic value's do.
 */
async function evaluate<T>(
  step: Step,
  input: {
    readonly decision: "history" | "next";
    readonly context: Decision;
    readonly field: (plan: Plan, ctx: PolicyContext) => Lazy<T> | undefined;
  },
): Promise<{ readonly ctx: PolicyContext; readonly value: T | undefined }> {
  const container = step.ctx as ContextContainer | undefined;
  const run = async (memo: Memo) => {
    const ctx = policyContext(step, input.context, memo);
    return { ctx, value: await force(input.field(policyOf(step)(ctx), ctx)) };
  };
  if (container === undefined || !container.has(SessionIdKey)) {
    return await run(() => {
      throw new Error(
        "ctx.memo keeps what it learns in the session's state, which this step doesn't carry.",
      );
    });
  }
  const { result } = await withMemos(
    container,
    {
      abortSignal: step.config.abortSignal,
      label: "the harness policy",
      scope: policyScope(input.decision),
    },
    run,
  );
  return result;
}

/**
 * Whether a policy other than eve's own decides how the session's turns end. Its model's answers
 * are drafts, and the turn's reply is what it settles with.
 */
export function policyDecides(step: Step): boolean {
  return policyOf(step) !== nativePolicy;
}

function policyOf(step: Step): Policy {
  return (
    step.config.policy ?? authoredPolicy(step.ctx as ContextContainer | undefined) ?? nativePolicy
  );
}

/** The coming model call's prompt, with the turn's input in history; or how the turn ended. */
export type BeforeModel = { readonly prompt: Prompt } | { readonly ended: StepResult };

/** The policy's answer is to call the model. */
const MODEL = Symbol("model");

/**
 * Readies a model call: the step's dynamic values are evaluated, then the turn's input joins
 * history, for every agent. Then a policy other than eve's own says what the turn does: at the
 * turn's start, after input joined. Right after it continued with a note, it
 * has decided already. What it reads, and what it does, is the same here as after a model step.
 */
export async function decideBeforeModel(step: Step, turn: TurnInput): Promise<BeforeModel> {
  const failed = await prepareModelCall(step, previewPrompt(step, turn));
  if (failed !== undefined) return { ended: failed };
  const noted = justNoted(step, turn.turnId);
  const prompt = await commitTurnInput(step, turn);
  if (!policyDecides(step) || noted) return { prompt };
  const decided = await decide(step, {});
  if ("ended" in decided) return decided;
  const applied = await apply(step, decided.ctx, decided.next);
  if (applied !== MODEL) return { ended: applied };
  // A note the policy added joined history after the input: the call reads it too.
  return { prompt: { ...prompt, messages: [...step.session.history] } };
}

/**
 * Asks the session's policy what the turn does after a model step that ended. A step whose
 * results the model hasn't read goes on to the next model call, where the policy decides.
 */
export async function decideAfterModel(step: Step, lastStep: ModelStep): Promise<StepResult> {
  // Results the model hasn't read are this step's own: an empty stop after reading results, or a
  // delivered reply that replaced them, leaves none.
  const unread = lastStep.madeCalls && step.session.history.at(-1)?.role === "tool";
  if (lastStep.output === undefined && unread && !lastStep.endsTurn) {
    return { next: step.runStep, session: step.session };
  }
  const decided = await decide(step, { lastStep });
  if ("ended" in decided) return decided.ended;
  const applied = await apply(step, decided.ctx, decided.next);
  return applied === MODEL ? { next: step.runStep, session: step.session } : applied;
}

/** Does what the policy answered, wherever it answered; `undefined` is eve's own loop. */
async function apply(
  step: Step,
  ctx: PolicyContext,
  answer: Next | undefined,
): Promise<StepResult | typeof MODEL> {
  const next = answer ?? nativeNext(ctx);
  const lastStep = ctx.turn?.lastStep;
  if ("model" in next) {
    const note = next.model.note;
    if (note === undefined) {
      // After a step, the model needs something it hasn't read; before one, it always has.
      if (lastStep !== undefined && ctx.turn?.unread !== true) {
        return await invalid(step, "called the model again with nothing new for it to read");
      }
      return MODEL;
    }
    if (typeof note !== "string" || note.trim().length === 0) {
      return await invalid(step, "continued with an empty note");
    }
    if (ctx.turn!.continuations >= MAX_CONTINUATIONS)
      return await apply(step, ctx, nativeNext(ctx));
    step.session = countNote(
      changeHistory(step.session, { append: [noteMessage(note, ctx.turn!.id)] }),
      ctx.turn!.id,
    );
    return MODEL;
  }
  if ("settle" in next) {
    // No turn ends while its tasks work: the session waits for one to settle, then decides again.
    if (ctx.tasks.working.length > 0) {
      return {
        held: { kind: "tasks", taskIds: ctx.tasks.working },
        next: null,
        session: step.session,
      };
    }
    return await settleTurn(step, next.settle, { lastStep });
  }
  if ("fail" in next) return await failWith(step, next.fail.message);
  return await invalid(step, "returned a next step eve doesn't know");
}

async function decide(
  step: Step,
  context: Decision,
): Promise<
  { readonly ctx: PolicyContext; readonly next: Next | undefined } | { readonly ended: StepResult }
> {
  try {
    const { ctx, value } = await evaluate(step, {
      context,
      decision: "next",
      field: (plan) => plan.next,
    });
    return { ctx, next: value };
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    log.error("the harness policy threw; failing the turn", {
      error,
      turnId: step.position().turnId,
    });
    return { ended: await failPolicy(step) };
  }
}

function noteMessage(note: string, turnId: string): HarnessModelMessage {
  return createFrameworkUserMessage("execution.continuation", note, { [NOTE_KEY]: turnId });
}

/** The policy continued the turn with a note, and the model hasn't read it yet. */
function justNoted(step: Step, turnId: string): boolean {
  const last = step.session.history.at(-1);
  return (
    last?.role === "user" &&
    last.kind === "execution.continuation" &&
    last.metadata?.[NOTE_KEY] === turnId
  );
}

const OUTPUT_SCHEMA_NOT_FULFILLED = {
  code: "OUTPUT_SCHEMA_NOT_FULFILLED",
  message: "The agent could not produce a result matching the requested schema.",
} as const;

type Settling = Extract<Next, { settle: unknown }>["settle"];

/**
 * Ends the turn. The model's own answer is already its reply and in history; under an output
 * schema it ends the turn only with a value the model delivered. An `own` output is the policy's
 * reply, which no model wrote: it has to match the output schema, replaces the step's draft in
 * history unless the policy keeps it, and is published as the turn's reply.
 */
async function settleTurn(
  step: Step,
  settling: Settling,
  input: { readonly lastStep?: ModelStep } = {},
): Promise<StepResult> {
  // A hook that failed after the turn's last model call fails it rather than let it complete.
  const hookFailure = await failTurnForReaction(step);
  if (hookFailure !== undefined) return hookFailure;
  const { output } = settling;
  const schema = step.session.outputSchema;
  // The schema belongs to the settled turn: a later turn that omits it doesn't inherit it.
  step.session = { ...clearTurnClientContextState(step.session), outputSchema: undefined };
  // A policy's reply is what it settles with; eve's own is the reply the model already wrote.
  const own = policyDecides(step);
  if (
    schema !== undefined &&
    !(own ? await matches(schema, output) : input.lastStep?.output !== undefined)
  ) {
    await step.apply(fail(step.view(), OUTPUT_SCHEMA_NOT_FULFILLED));
    return {
      next: null,
      session: step.session,
      settledTurn: { isError: true, output: OUTPUT_SCHEMA_NOT_FULFILLED.message },
    };
  }
  const text = output === null || typeof output === "string" ? output : JSON.stringify(output);
  if (own) {
    replyInHistory(step, text);
    // A structured result is the turn's whatever it is; a text reply that says nothing posts none.
    if (schema !== undefined || (output !== null && output !== "")) {
      const turnId = step.position().turnId;
      await step.apply([
        fact("content.completed", {
          kind: schema === undefined ? "text" : "result",
          partId: `${turnId}.reply`,
          phase: "reply",
          turnId,
          value: schema === undefined ? text : output,
        }),
      ]);
    }
  }
  await step.apply(
    turnSettled(step.view().projection, { outcome: "completed" }),
    step.session.history,
  );
  return {
    next: null,
    session: step.session,
    settledTurn: { output: schema === undefined ? (text ?? "") : output },
  };
}

async function matches(schema: JsonObject, output: JsonValue | null): Promise<boolean> {
  const checked = await defineJsonSchema(schema)["~standard"].validate(output);
  if (checked.issues === undefined) return true;
  log.error("the turn settled with output its schema rejects", {
    issues: checked.issues.map((issue) => issue.message),
  });
  return false;
}

/**
 * The policy's reply joins history, unless it's what the model just wrote: history only grows,
 * so the model's own messages stay as it wrote them.
 */
function replyInHistory(step: Step, text: string | null): void {
  if (text === null || text === "") return;
  const last = step.session.history.at(-1);
  if (last?.role === "assistant" && assistantText(last) === text) return;
  step.session = changeHistory(step.session, { append: [{ content: text, role: "assistant" }] });
}

function assistantText(message: HarnessModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function failWith(step: Step, message: unknown): Promise<StepResult> {
  if (typeof message !== "string" || message.trim().length === 0) {
    return await invalid(step, "failed the turn without a message");
  }
  step.session = { ...clearTurnClientContextState(step.session), outputSchema: undefined };
  await step.apply(fail(step.view(), { code: "HARNESS_FAILED", message }));
  return { next: null, session: step.session, settledTurn: { isError: true, output: message } };
}

/** A policy threw where eve can't fail the turn itself; the cause stays out of the message. */
export class PolicyFailedError extends Error {
  override readonly name = "PolicyFailedError";
  readonly code = HARNESS_FAILED.code;
  constructor(cause: unknown) {
    super(HARNESS_FAILED.message, { cause });
  }
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
  try {
    const { value } = await evaluate(step, {
      context: {
        ...(input.compact !== undefined && { compact: input.compact }),
        history: input.messages,
        size: input.size,
        summarize,
      },
      decision: "history",
      field: (plan, ctx) => async () =>
        (await force(plan.history)) ?? (await nativeHistory(ctx, options)),
    });
    return value!;
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    if (typeof error === "object" && error !== null && failures.has(error)) throw error;
    log.error("the harness policy's history threw", { error, turnId: step.position().turnId });
    throw new PolicyFailedError(error);
  }
}

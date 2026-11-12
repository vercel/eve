import type { ModelMessage } from "ai";

import { Validator } from "#compiled/@cfworker/json-schema/index.js";

import { stepDraft } from "#definitions/step.js";
import { turnReplyPart } from "#harness/session-machine/content.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { complete, fail } from "#harness/session-machine/transitions.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  isUserModelMessage,
} from "#harness/messages.js";
import { failTurnForEffect, type Step } from "#harness/step/context.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import type { StepResult } from "#harness/types.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import type {
  HarnessAction,
  HarnessAdmission,
  HarnessContext,
  HarnessStep,
} from "#public/definitions/harness.js";
import type { JsonValue } from "#shared/json.js";
import { HARNESS_NOTE_KEY, harnessContext } from "#definitions/harness/context.js";
import { STEERING_POLICY_STATE_KEY } from "#execution/session/input-queue.js";
import {
  changesStage,
  type HarnessStack,
  NothingBelowError,
  runStage,
  sessionHarness,
} from "#definitions/harness/stack.js";

// Where the kernel asks the harness: what the model reads of the history on each call, and what
// happens next in the turn. eve's own answer is each stage's bottom; the kernel checks what the
// stack decides before it acts, so no layer can end a turn its tasks still work in, or loop the
// model on nothing new.

const log = createLogger("harness.stack");

/** The notes a harness can add in one turn before the kernel fails it. */
export const MAX_HARNESS_NOTES = 10;

/** What a step's stages read. */
export function stepHarnessContext(
  step: Step,
  input: { readonly lastStep?: HarnessStep; readonly pending?: readonly ModelMessage[] } = {},
): HarnessContext {
  const draft = stepDraft(step);
  return harnessContext(step.ctx, {
    history: step.session.history,
    ...(input.lastStep !== undefined && { lastStep: input.lastStep }),
    ...(input.pending !== undefined && { pending: input.pending }),
    system: async () => await (await draft).system(),
    tools: async () => await (await draft).tools(),
    view: step.view().projection.view,
  });
}

/** What the model reads of `messages` on this call, after the harness's `history` stage. */
export async function projectHistory(
  step: Step,
  messages: HarnessModelMessage[],
): Promise<HarnessModelMessage[]> {
  const stack = await sessionHarness(step.ctx);
  if (!changesStage(stack, "history")) return messages;
  const projected = await runStage(
    stack,
    "history",
    stepHarnessContext(step),
    async () => messages,
  );
  return fromHarnessMessages(projected);
}

/**
 * Messages a harness returned, as history holds them: a user-role message it wrote itself is the
 * framework's, not the person's.
 */
export function fromHarnessMessages(messages: readonly ModelMessage[]): HarnessModelMessage[] {
  return messages.map((message) =>
    message.role !== "user" || isUserModelMessage(message)
      ? (message as HarnessModelMessage)
      : createFrameworkUserMessage("context.instruction", message.content),
  );
}

/**
 * Asks the harness's `admit` stage who may steer the turn, and records it where the session loop
 * reads it, at every step. eve's own answer, `"caller"`, is below every layer, naked or not:
 * admission is the kernel's, which a harness can only narrow.
 */
export async function recordAdmission(step: Step): Promise<void> {
  const stack = await sessionHarness(step.ctx);
  if (!stack.layers.some((layer) => typeof layer.definition.admit === "function")) return;
  const decided = await runStage(
    stack,
    "admit",
    stepHarnessContext(step),
    async (): Promise<HarnessAdmission> => ({ steer: "caller" }),
  );
  const steer = decided.steer === "nobody" ? "nobody" : "caller";
  if (step.session.state?.[STEERING_POLICY_STATE_KEY] === steer) return;
  step.session = {
    ...step.session,
    state: { ...step.session.state, [STEERING_POLICY_STATE_KEY]: steer },
  };
}

/** Whether the kernel asks the stack what's next, rather than acting on eve's own answer. */
export async function decidesNext(step: Step): Promise<HarnessStack | undefined> {
  const stack = await sessionHarness(step.ctx);
  return changesStage(stack, "next") ? stack : undefined;
}

/** What the stack decides comes next, with eve's own answer at its bottom. */
export async function decideNext(
  step: Step,
  stack: HarnessStack,
  input: {
    readonly native: HarnessAction;
    readonly lastStep?: HarnessStep;
    /** The turn's input, before it joins the history. */
    readonly pending?: readonly ModelMessage[];
  },
): Promise<HarnessAction> {
  const ctx = stepHarnessContext(step, input);
  return await runStage(stack, "next", ctx, async () => {
    if (stack.naked) throw new NothingBelowError("next", stack);
    return input.native;
  });
}

/** The harness asked for another model call: its note joins history, counted against the cap. */
export async function continueWithNote(
  step: Step,
  note: string | undefined,
  input: { readonly unread: boolean },
): Promise<StepResult> {
  if (note === undefined || note.trim() === "") {
    if (input.unread) return { next: step.runStep, session: step.session };
    return await failHarness(
      step,
      "HARNESS_INVALID",
      "The harness called the model again with nothing new for it to read. Return a note, or settle.",
    );
  }
  const turnId = activeTurnId(step.position());
  const notes = step.session.history.filter(
    (message) => message.role === "user" && message.metadata?.[HARNESS_NOTE_KEY] === turnId,
  ).length;
  if (notes >= MAX_HARNESS_NOTES) {
    return await failHarness(
      step,
      "HARNESS_NOTE_LIMIT",
      `The harness added ${MAX_HARNESS_NOTES} notes in one turn without settling it.`,
    );
  }
  const message = createFrameworkUserMessage("execution.continuation", note, {
    [HARNESS_NOTE_KEY]: turnId,
  });
  step.session = changeHistory(step.session, { append: [message] });
  return { next: step.runStep, session: step.session };
}

/**
 * Settles the turn with a reply the harness wrote: a part of the turn's own, which becomes its
 * reply, and the assistant message the next turn reads. A structured turn's reply must be a value
 * its output schema accepts, whoever writes it.
 */
export async function settleWithReply(step: Step, value: JsonValue): Promise<StepResult> {
  const hookFailure = await failTurnForEffect(step);
  if (hookFailure !== undefined) return hookFailure;
  const schema = step.session.outputSchema;
  // The schema belongs to the turn it settles: a later turn doesn't inherit it.
  step.session = { ...clearTurnClientContextState(step.session), outputSchema: undefined };
  if (schema !== undefined) {
    const checked = new Validator(schema as ConstructorParameters<typeof Validator>[0]).validate(
      value,
    );
    if (!checked.valid) {
      return await failHarness(
        step,
        "OUTPUT_SCHEMA_NOT_FULFILLED",
        "The agent could not produce a result matching the requested schema.",
        checked.errors,
      );
    }
  }
  if (value !== null) {
    const turnId = activeTurnId(step.position());
    const reply = (step.view().projection.view.turns[turnId]?.reply ?? []).length;
    const text = typeof value === "string" && schema === undefined ? value : JSON.stringify(value);
    await step.apply(
      turnReplyPart({
        kind: schema === undefined ? "text" : "result",
        partId: `${turnId}.harness.${reply}`,
        turnId,
        value: schema === undefined ? text : value,
      }),
    );
    step.session = changeHistory(step.session, {
      append: [{ content: text, role: "assistant" }],
    });
  }
  await step.apply(complete(step.view()), step.session.history);
  return { next: null, session: step.session, settledTurn: { output: value ?? "" } };
}

/** The turn fails for what the harness did; its own error stays in the logs. */
export async function failHarness(
  step: Step,
  code: string,
  message: string,
  error?: unknown,
): Promise<StepResult> {
  const errorId = createErrorId();
  log.error("the harness failed the turn", { code, error, errorId, message });
  await step.apply(fail(step.view(), { code, details: { errorId }, message }));
  return { next: null, session: step.session, settledTurn: { isError: true, output: message } };
}

/** Runs `decide`, failing the turn when a layer throws. */
export async function harnessed<T>(
  step: Step,
  decide: () => Promise<T>,
): Promise<{ readonly value: T } | { readonly failed: StepResult }> {
  try {
    return { value: await decide() };
  } catch (error) {
    return {
      failed: await failHarness(
        step,
        "HARNESS_FAILED",
        "The agent's harness failed. Inspect the session's logs for details.",
        error,
      ),
    };
  }
}

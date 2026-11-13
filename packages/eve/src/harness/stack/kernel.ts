import type { ModelMessage, ToolSet } from "ai";

import { Validator } from "#compiled/@cfworker/json-schema/index.js";

import { stepDraft } from "#definitions/step.js";
import { turnReplyPart } from "#harness/session-machine/content.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { complete, fail } from "#harness/session-machine/transitions.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import {
  isTaskWorking,
  readTaskTable,
  tasksWithResults,
  workingTasks,
} from "#execution/tasks/table.js";
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
  HarnessAdmitContext,
  HarnessContext,
  HarnessDelivery,
  HarnessRequest,
  HarnessStep,
  HarnessTask,
  HarnessTools,
} from "#public/definitions/harness.js";
import type { JsonValue } from "#shared/json.js";
import {
  HARNESS_NOTE_KEY,
  harnessContext,
  partsOf,
  sectionsOf,
} from "#definitions/harness/context.js";
import { EMPTY_TOOLS, type Section } from "#definitions/definition.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { HARNESS_ADMITS_STATE_KEY } from "#execution/session/input-queue.js";
import type { ContextContainer } from "#context/container.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import {
  hasStage,
  NothingBelowError,
  runStage,
  sessionHarness,
} from "#definitions/harness/stack.js";

// Where the kernel asks the harness: the last change to each model call before it's sent, and what
// happens next in the turn. eve's own answer is each stage's bottom; the kernel checks what the
// stack decides before it acts, so no layer can end a turn its tasks still work in, or loop the
// model on nothing new.

const log = createLogger("harness.stack");

/** The notes a harness can add in one turn before the kernel fails it. */
export const MAX_HARNESS_NOTES = 10;

/** Where the session counts the notes the harness added in the open turn. */
const HARNESS_NOTES_STATE_KEY = "eve.harness.notes";

/** The notes the harness added in the open turn. */
function notesOf(step: Step): number {
  const turnId = activeTurnIdOf(step.view().projection);
  const kept = step.session.state?.[HARNESS_NOTES_STATE_KEY] as
    | { readonly count?: unknown; readonly turnId?: unknown }
    | undefined;
  return turnId !== undefined && kept?.turnId === turnId && typeof kept.count === "number"
    ? kept.count
    : 0;
}

/** The session's tasks, as a harness reads them. */
function tasksOf(step: Step): readonly HarnessTask[] {
  return readTaskTable(step.session.state).tasks.map((record) => ({
    results: record.results.map((result): JsonValue =>
      result.status === "completed" ? result.output : { error: result.error },
    ),
    status: record.cancelled === true ? "cancelled" : isTaskWorking(record) ? "running" : "idle",
    taskId: record.id,
    tool: record.name,
  }));
}

/**
 * The harness waits on tasks itself: on those it names that still work. A wait on none would
 * hold the turn forever, so it fails instead.
 */
export async function waitOnTasks(step: Step, tasks: readonly string[]): Promise<StepResult> {
  const working = new Set(workingTasks(readTaskTable(step.session.state)).map(({ id }) => id));
  const taskIds = tasks.filter((taskId) => working.has(taskId));
  if (taskIds.length === 0) {
    return await failHarness(
      step,
      "HARNESS_INVALID",
      "The harness waited on tasks, but none it named work.",
    );
  }
  return { held: { kind: "tasks", taskIds }, next: null, session: step.session };
}

/** Whether a task's results arrived that the model hasn't read: the harness reads them first. */
export function hasUnreadTaskResults(step: Step): boolean {
  return tasksWithResults(readTaskTable(step.session.state)).length > 0;
}

/** What a step's stages read. */
export function stepHarnessContext(
  step: Step,
  input: { readonly lastStep?: HarnessStep; readonly pending?: readonly ModelMessage[] } = {},
): HarnessContext {
  const draft = stepDraft(step);
  return harnessContext(step.ctx, {
    history: step.session.history,
    notes: notesOf(step),
    tasks: tasksOf(step),
    ...(input.lastStep !== undefined && { lastStep: input.lastStep }),
    ...(input.pending !== undefined && { pending: input.pending }),
    system: async () => await (await draft).system(),
    tools: async () => await (await draft).tools(),
    view: step.view().projection.view,
  });
}

/** One model call as the kernel sends it: the system prompt's sections, messages, and tools. */
export interface CallRequest {
  readonly sections: readonly Section[];
  readonly messages: readonly HarnessModelMessage[];
  readonly tools: ToolSet;
}

/**
 * The call the `request` stage makes of `request`, the last change before it's sent, or
 * `undefined` when no layer has one. It runs after context is placed, so it reads the call as the
 * model would. What it returns is used once: the history the step commits is unchanged. It may
 * narrow the tools, never add one, since a tool's code is its definition's.
 */
export async function shapeRequest(
  step: Step,
  request: CallRequest,
): Promise<CallRequest | undefined> {
  const stack = await sessionHarness(step.ctx);
  if (!hasStage(stack, "request")) return undefined;
  const offered = toRequestTools(request.tools);
  // Below every layer, naked or not, is the call as the agent's definitions built it.
  const shaped = await runStage(
    stack,
    "request",
    () => stepHarnessContext(step),
    async (): Promise<HarnessRequest> => ({
      instructions: partsOf(request.sections),
      messages: request.messages,
      tools: offered,
    }),
  );
  const tools: ToolSet = {};
  for (const [name, tool] of shaped.tools) {
    const was = request.tools[name];
    if (was === undefined || tool.name !== name) {
      throw new Error(
        `The harness's \`request\` offered a tool "${tool.name}" the call doesn't have. A request can only narrow the tools.`,
      );
    }
    tools[name] =
      tool.description === descriptionOf(was)
        ? was
        : ({ ...was, description: tool.description } as ToolSet[string]);
  }
  // The structured reply tool is the caller's contract, which no harness narrows away.
  const reply = request.tools[REPLY_TOOL_NAME];
  if (reply !== undefined) tools[REPLY_TOOL_NAME] ??= reply;
  return {
    messages: fromHarnessMessages(shaped.messages),
    sections: sectionsOf(request.sections, shaped.instructions, "request"),
    tools,
  };
}

function toRequestTools(tools: ToolSet): HarnessTools {
  return new Map(
    Object.entries(tools).map(([name, tool]) => [
      name,
      { deferred: false, description: descriptionOf(tool), name },
    ]),
  );
}

/** A tool's description as the request shows it: one the AI SDK computes per call reads empty. */
function descriptionOf(tool: ToolSet[string]): string {
  return typeof tool.description === "string" ? tool.description : "";
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
 * Records whether the session's harness has an `admit` stage, where the session loop reads it, so
 * the loop asks the harness about each message that arrives during a turn only when it has one.
 */
export async function recordAdmits(step: Step): Promise<void> {
  const stack = await sessionHarness(step.ctx);
  const admits = stack.layers.some((layer) => typeof layer.definition.admit === "function");
  if ((step.session.state?.[HARNESS_ADMITS_STATE_KEY] === true) === admits) return;
  const { [HARNESS_ADMITS_STATE_KEY]: _was, ...state } = step.session.state ?? {};
  step.session = {
    ...step.session,
    state: admits ? { ...state, [HARNESS_ADMITS_STATE_KEY]: true } : state,
  };
}

/**
 * What a message that arrived during a turn does, as the stack's `admit` decides, with eve's own
 * answer at its bottom, naked or not: admission is the kernel's, which a harness only narrows.
 */
export async function decideAdmission(
  container: ContextContainer,
  input: {
    readonly delivery: HarnessDelivery;
    readonly eve: HarnessAdmission["action"];
    readonly view: SessionView;
  },
): Promise<HarnessAdmission> {
  const stack = await sessionHarness(container);
  // A message is decided without reading the conversation, so deciding stays cheap.
  const ctx = (): HarnessAdmitContext => ({
    ...harnessContext(container, {
      history: [],
      system: async () => [],
      tools: async () => EMPTY_TOOLS,
      view: input.view,
    }),
    delivery: input.delivery,
  });
  const decided = await runStage(stack, "admit", ctx, async (): Promise<HarnessAdmission> => ({
    action: input.eve,
  }));
  if (!ADMIT_ACTIONS.has(decided.action)) {
    throw new Error(
      `The harness's \`admit\` returned "${String(decided.action)}". Return join, queue, turn, or drop.`,
    );
  }
  return decided;
}

const ADMIT_ACTIONS = new Set(["join", "queue", "turn", "drop"]);

/**
 * What the stack decides comes next, with eve's own answer at its bottom. Every agent's turn goes
 * through here: with no layer that changes `next`, the answer is eve's own.
 */
export async function decideNext(
  step: Step,
  input: {
    readonly native: HarnessAction;
    readonly lastStep?: HarnessStep;
    /** The turn's input, before it joins the history. */
    readonly pending?: readonly ModelMessage[];
  },
): Promise<HarnessAction> {
  const stack = await sessionHarness(step.ctx);
  return await runStage(
    stack,
    "next",
    () => stepHarnessContext(step, input),
    async () => {
      if (stack.naked) throw new NothingBelowError("next", stack);
      return input.native;
    },
  );
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
  const notes = notesOf(step);
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
  // Counted in the session's state, not its history: a compaction that drops notes doesn't
  // reset the count.
  step.session = {
    ...step.session,
    state: { ...step.session.state, [HARNESS_NOTES_STATE_KEY]: { count: notes + 1, turnId } },
  };
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

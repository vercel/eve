import type { ModelMessage } from "ai";

import { activeTurnId } from "#harness/active-turn-id.js";
import { stageAttachmentsToSandbox } from "#harness/attachment-staging.js";
import {
  getPendingCoordinationBatch,
  type PendingCoordinationBatch,
  resolvePendingCoordination,
} from "#harness/coordination.js";
import {
  createFrameworkUserMessage,
  createUserMessage,
  frameworkMessageKindForStepInput,
  type HarnessModelMessage,
  normalizeUserContent,
  TOOL_RESULT_BOUNDARY,
  type UserModelMessage,
} from "#harness/messages.js";
import { consumeDeferredStepInput } from "#harness/pending-input-batches.js";
import { getTurnClientContextState } from "#harness/turn-client-context.js";
import type { StepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import type { Step } from "./context.js";

/** What the runtime delivered for a step parked on its calls, and the input the step runs. */
export interface RuntimeWork {
  /** The step's input, after input queued behind earlier work. */
  readonly input: StepInput | undefined;
  /** History, with the parked step's response and the results the runtime delivered for it. */
  readonly messages: readonly ModelMessage[];
  /** The parked step the delivered results resumed. */
  readonly resumed: PendingCoordinationBatch | undefined;
}

/**
 * Settles the calls the runtime ran for a parked step. Returns `undefined` while some are still
 * running: input queued behind them waits until they have.
 */
export async function settleRuntimeWork(
  step: Step,
  input: StepInput | undefined,
): Promise<RuntimeWork | undefined> {
  const parked = getPendingCoordinationBatch(step.session.state);
  // Queued input waits for the parked step: coalescing would drop its runtime results, and input
  // queued behind approved workflows must replay only after they finish.
  if (parked === undefined) {
    const queued = consumeDeferredStepInput({ input, session: step.session });
    step.session = queued.session;
    input = queued.input;
  }
  const settled = await resolvePendingCoordination({
    emit: step.emit,
    session: step.session,
    stepInput: input,
    tools: step.config.tools,
  });
  if (settled.outcome === "unresolved") return undefined;
  step.session = settled.session;
  return {
    input,
    messages: settled.messages,
    resumed: settled.outcome === "resolved" ? parked : undefined,
  };
}

/** The turn's input as the model reads it. */
export interface TurnInput {
  readonly turnId: string;
  /** Context the client sent for this turn, which never joins history. */
  readonly clientContext: readonly string[] | undefined;
  readonly storedClientContext: ReturnType<typeof getTurnClientContextState>;
  readonly ephemeral: readonly UserModelMessage[];
  /** The context entries and the message, in history order. */
  readonly messages: readonly UserModelMessage[];
  /** The input carries a user's message, which follows tool results across a boundary. */
  readonly hasUserMessage: boolean;
}

/**
 * Prepares the turn's input: client and context entries, and the message with its attachments
 * staged to the sandbox. Input an approval defers to a later step, and a message a plain-text
 * answer consumed, never reach this step's model call.
 */
export async function prepareTurnInput(
  step: Step,
  input: StepInput | undefined,
  options: {
    readonly consumedMessage: boolean;
    readonly deferredContext: boolean;
    readonly deferredMessage: boolean;
  },
): Promise<TurnInput> {
  const turnId = activeTurnId(step.position());
  const storedClientContext = getTurnClientContextState(step.session.state, turnId);
  const clientContext = options.deferredContext ? undefined : readClientContext(input);
  const ephemeral =
    (clientContext ?? storedClientContext?.messages)?.map((content) =>
      createFrameworkUserMessage("context.instruction", content),
    ) ?? [];
  const messages: UserModelMessage[] = options.deferredContext
    ? []
    : (input?.context ?? []).map((entry) =>
        createFrameworkUserMessage("context.instruction", entry),
      );
  const kind = frameworkMessageKindForStepInput(input);
  const content = normalizeUserContent(input?.message);
  const staged =
    content !== undefined && !options.deferredMessage && !options.consumedMessage
      ? await stageAttachmentsToSandbox(content)
      : undefined;
  if (staged !== undefined) {
    messages.push(
      kind === undefined
        ? createUserMessage("user", staged)
        : createFrameworkUserMessage(kind, staged),
    );
  }
  return {
    clientContext,
    ephemeral,
    hasUserMessage: staged !== undefined && kind === undefined,
    messages,
    storedClientContext,
    turnId,
  };
}

/** The turn's input as it follows tool results: a user message needs a boundary before it. */
export function followingToolResults(turn: TurnInput): HarnessModelMessage[] {
  return [
    ...(turn.hasUserMessage ? [{ content: TOOL_RESULT_BOUNDARY, role: "assistant" } as const] : []),
    ...turn.messages,
  ];
}

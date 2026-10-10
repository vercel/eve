import { stageAttachmentsToSandbox, stageToolResultMedia } from "#harness/attachment-staging.js";
import { forgetFinishedRuns, runtimeResultCalls } from "#harness/coordination.js";
import {
  createFrameworkUserMessage,
  createUserMessage,
  frameworkMessageKindForStepInput,
  type HarnessModelMessage,
  normalizeUserContent,
  TOOL_RESULT_BOUNDARY,
  type UserModelMessage,
} from "#harness/messages.js";
import { finishRun, settle } from "#harness/session-machine/transitions.js";
import { activeTurnId, runtimeWait } from "#harness/session-machine/view.js";
import { getTurnClientContextState } from "#harness/turn-client-context.js";
import type { StepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { Step } from "./context.js";

/**
 * Settles the calls the runtime ran for parked steps. Returns `undefined` while some are still
 * running: input queued behind them waits until they have. Otherwise returns the step's input
 * without the results it settled, and whether the step waited on any.
 */
export async function settleRuntimeWork(
  step: Step,
  input: StepInput | undefined,
): Promise<{ readonly input: StepInput | undefined; readonly waited: boolean } | undefined> {
  const runtime = runtimeWait(step.session.state);
  if (runtime === undefined) return { input, waited: false };
  const ready = resolveRuntimeActionResultsForCallIds({
    pendingCallIds: runtime.callIds,
    results: input?.runtimeActionResults ?? [],
  });
  if (ready === undefined) return undefined;
  const finished = forgetFinishedRuns(step.session, ready, runtime.event.turnId);
  step.session = finished.session;
  await step.apply(finishRun(step.view(), { requestIds: finished.requestIds }));
  const results = await runtimeResultCalls(ready, step.config.tools);
  const staged = await stageToolResultMedia([
    { role: "tool", content: results.map(({ part }) => part) },
  ]);
  const parts = staged.flatMap((message) =>
    message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : [],
  );
  await step.apply(
    settle(step.view(), {
      results: results.map((result, index) => ({ ...result, part: parts[index]! })),
    }),
  );
  if (input === undefined) return { input, waited: true };
  const { runtimeActionResults: _results, ...rest } = input;
  return { input: rest, waited: true };
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
 * staged to the sandbox. A message a plain-text answer consumed never reaches the model.
 */
export async function prepareTurnInput(
  step: Step,
  input: StepInput | undefined,
  options: { readonly consumedMessage: boolean },
): Promise<TurnInput> {
  const turnId = activeTurnId(step.position());
  const storedClientContext = getTurnClientContextState(step.session.state, turnId);
  const clientContext = readClientContext(input);
  const ephemeral =
    (clientContext ?? storedClientContext?.messages)?.map((content) =>
      createFrameworkUserMessage("context.instruction", content),
    ) ?? [];
  const messages: UserModelMessage[] = (input?.context ?? []).map((entry) =>
    createFrameworkUserMessage("context.instruction", entry),
  );
  const kind = frameworkMessageKindForStepInput(input);
  const content = normalizeUserContent(input?.message);
  const staged =
    content !== undefined && !options.consumedMessage
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

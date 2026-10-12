import { stageAttachmentsToSandbox, stageToolResultMedia } from "#harness/attachment-staging.js";
import { forgetFinishedRuns, runtimeResultCalls } from "#harness/coordination.js";
import {
  createFrameworkUserMessage,
  createUserMessage,
  frameworkMessageKindForStepInput,
  type HarnessModelMessage,
  normalizeMessage,
  userContentOf,
  TOOL_RESULT_BOUNDARY,
  type UserModelMessage,
} from "#harness/messages.js";
import { finishRun, settle } from "#harness/session-machine/transitions.js";
import { delegatedUsageFact } from "#harness/facts.js";
import { activeTurnId, runtimeWait } from "#harness/session-machine/view.js";
import { getTurnClientContextState } from "#harness/turn-client-context.js";
import type { HarnessStepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { Step } from "./context.js";
import type { TokenUsage } from "#shared/token-usage.js";

/**
 * Settles the calls the runtime ran for parked steps. Returns `undefined` while some are still
 * running: input queued behind them waits until they have. Otherwise returns the step's input
 * without the results it settled, and whether the step waited on any.
 */
export async function settleRuntimeWork(
  step: Step,
  input: HarnessStepInput | undefined,
): Promise<{ readonly input: HarnessStepInput | undefined; readonly waited: boolean } | undefined> {
  const runtime = runtimeWait(step.session.state);
  if (runtime === undefined) {
    // Nothing waits on these calls any more, but what their agents spent still counts.
    await recordLateSpend(step, input?.delegatedUsage, new Set());
    if (input?.delegatedUsage === undefined) return { input, waited: false };
    const { delegatedUsage: _usage, ...rest } = input;
    return { input: rest, waited: false };
  }
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
  const usage = input?.delegatedUsage ?? {};
  await recordLateSpend(step, usage, new Set(results.map(({ part }) => part.toolCallId)));
  await step.apply(
    settle(step.view(), {
      results: results.map((result, index) => ({
        ...result,
        part: parts[index]!,
        usage: usage[result.part.toolCallId],
      })),
    }),
  );
  if (input === undefined) return { input, waited: true };
  const { delegatedUsage: _usage, runtimeActionResults: _results, ...rest } = input;
  return { input: rest, waited: true };
}

/**
 * Delegated spend no call this step settles records: its call settled earlier, or the turn no
 * longer waits on it. No open entity owns it, so it's the session's `delegated-late` usage.
 */
async function recordLateSpend(
  step: Step,
  usage: Readonly<Record<string, TokenUsage>> | undefined,
  settled: ReadonlySet<string>,
): Promise<void> {
  const late = Object.entries(usage ?? {}).filter(([callId]) => !settled.has(callId));
  if (late.length > 0)
    await step.publish(late.map(([, spent]) => delegatedUsageFact(undefined, spent)));
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
  input: HarnessStepInput | undefined,
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
  const content = normalizeMessage(input?.message);
  const staged =
    content !== undefined && !options.consumedMessage
      ? await stageAttachmentsToSandbox(userContentOf(content))
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

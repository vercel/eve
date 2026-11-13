import { stageAttachmentsToSandbox, stageToolResultMedia } from "#harness/attachment-staging.js";
import { stepCatalog } from "#definitions/step.js";
import { forgetFinishedRuns, runtimeResultCalls } from "#harness/coordination.js";
import { endsTurnTools } from "#harness/model-call/tools.js";
import { callsEndTurn } from "#harness/step/after-model.js";
import {
  anchorToTurn,
  createFrameworkUserMessage,
  createImportedHistoryMessages,
  createUserMessage,
  frameworkMessageKindForStepInput,
  type HarnessModelMessage,
  normalizeMessage,
  userContentOf,
  TOOL_RESULT_BOUNDARY,
  type UserModelMessage,
} from "#harness/messages.js";
import { finishRun, settle } from "#harness/session-machine/transitions.js";
import { recordLateSpend as recordLateSpendFact } from "#harness/session-machine/runs.js";
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
 * without the results it settled, whether the step waited on any, and whether those results end
 * the turn.
 */
export async function settleRuntimeWork(
  step: Step,
  input: HarnessStepInput | undefined,
): Promise<
  | {
      readonly endsTurn: boolean;
      readonly input: HarnessStepInput | undefined;
      readonly waited: boolean;
    }
  | undefined
> {
  const runtime = runtimeWait(step.session.state);
  if (runtime === undefined) {
    // Nothing waits on these calls any more, but what their agents spent still counts.
    await recordLateSpend(step, input?.delegatedUsage, new Set());
    if (input?.delegatedUsage === undefined) return { endsTurn: false, input, waited: false };
    const { delegatedUsage: _usage, ...rest } = input;
    return { endsTurn: false, input: rest, waited: false };
  }
  const ready = resolveRuntimeActionResultsForCallIds({
    pendingCallIds: runtime.callIds,
    results: input?.runtimeActionResults ?? [],
  });
  if (ready === undefined) return undefined;
  const finished = forgetFinishedRuns(step.session, ready, runtime.event.turnId);
  step.session = finished.session;
  await step.apply(finishRun(step.view(), { requestIds: finished.requestIds }));
  const catalog = await stepCatalog(step);
  const results = await runtimeResultCalls(ready, catalog);
  const staged = await stageToolResultMedia([
    { role: "tool", content: results.map(({ part }) => part) },
  ]);
  const parts = staged.flatMap((message) =>
    message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : [],
  );
  const usage = input?.delegatedUsage ?? {};
  await recordLateSpend(step, usage, new Set(results.map(({ part }) => part.toolCallId)));
  const suspended = step.view().turn.suspended;
  await step.apply(
    settle(step.view(), {
      results: results.map((result, index) => ({
        ...result,
        part: parts[index]!,
        usage: usage[result.part.toolCallId],
      })),
    }),
  );
  // The turn ends here only when these results settle every call of a parked response and each
  // ends the turn; a call something else answered, a provider's included, keeps the model in the
  // loop.
  const settledIds = new Set(results.map(({ part }) => part.toolCallId));
  const endsTurn =
    suspended.length > 0 &&
    suspended.every(({ messages }) =>
      messages.every(
        ({ content, role }) =>
          role !== "assistant" ||
          typeof content === "string" ||
          content.every((part) => part.type !== "tool-call" || settledIds.has(part.toolCallId)),
      ),
    ) &&
    (await callsEndTurn(
      results.map(({ part, result }) => ({
        failed: result.isError === true,
        output: result.output,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      })),
      endsTurnTools(catalog, step.endsTurn),
    ));
  if (input === undefined) return { endsTurn, input, waited: true };
  const { delegatedUsage: _usage, runtimeActionResults: _results, ...rest } = input;
  return { endsTurn, input: rest, waited: true };
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
  if (late.length > 0) await step.publish(recordLateSpendFact(late.map(([, spent]) => spent)));
}

/** The turn's input as the model reads it. */
export interface TurnInput {
  readonly turnId: string;
  /** Context the client sent for this turn, which never joins history. */
  readonly clientContext: readonly string[] | undefined;
  readonly storedClientContext: ReturnType<typeof getTurnClientContextState>;
  readonly ephemeral: readonly UserModelMessage[];
  /** Imported history, the context entries, and the message, in history order. */
  readonly messages: readonly HarnessModelMessage[];
  /** The input carries a user's message, which follows tool results across a boundary. */
  readonly hasUserMessage: boolean;
  /** The message with its attachments staged, so input queued again isn't staged twice. */
  readonly message: HarnessStepInput["message"];
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
  // Imported history is earlier conversation, so what eve adds for this turn sits after it.
  const messages: HarnessModelMessage[] = [
    ...createImportedHistoryMessages(input?.history ?? []),
    ...(input?.context ?? []).map((entry) =>
      anchorToTurn(createFrameworkUserMessage("context.instruction", entry), turnId),
    ),
  ];
  const kind = frameworkMessageKindForStepInput(input);
  const content = normalizeMessage(input?.message);
  const staged =
    content !== undefined && !options.consumedMessage
      ? await stageAttachmentsToSandbox(userContentOf(content))
      : undefined;
  if (staged !== undefined) {
    if (isContinuation(step, input)) {
      messages.push(
        anchorToTurn(createFrameworkUserMessage("context.instruction", CONTINUATION_NOTE), turnId),
      );
    }
    messages.push(
      anchorToTurn(
        kind === undefined
          ? createUserMessage("user", staged)
          : createFrameworkUserMessage(kind, staged),
        turnId,
      ),
    );
  }
  return {
    clientContext,
    ephemeral,
    hasUserMessage: staged !== undefined && kind === undefined,
    // Staging keeps a message's text and file parts, with each file a sandbox ref.
    message: staged as HarnessStepInput["message"],
    messages,
    storedClientContext,
    turnId,
  };
}

const CONTINUATION_NOTE =
  "The next message was sent automatically after the last turn, not by a person.";

/**
 * Whether hooks' `ctx.continue()` sent all of the input, read from its deliveries' `source.hook`,
 * which the admission commit recorded before the step. The note goes into history with the
 * message, so the prompt the model reads matches what's stored.
 */
function isContinuation(step: Step, input: HarnessStepInput | undefined): boolean {
  const deliveries = input?.deliveries ?? [];
  const rows = step.view().projection.view.deliveries;
  return (
    deliveries.length > 0 &&
    deliveries.every(({ deliveryId }) => {
      const source = rows[deliveryId]?.source;
      return source !== undefined && "hook" in source && source.hook !== undefined;
    })
  );
}

/** The turn's input as it follows tool results: a user message needs a boundary before it. */
export function followingToolResults(turn: TurnInput): HarnessModelMessage[] {
  return [
    ...(turn.hasUserMessage ? [{ content: TOOL_RESULT_BOUNDARY, role: "assistant" } as const] : []),
    ...turn.messages,
  ];
}

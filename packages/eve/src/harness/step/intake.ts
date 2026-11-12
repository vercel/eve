import { stageAttachmentsToSandbox, stageToolResultMedia } from "#harness/attachment-staging.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ParentSessionKey } from "#context/keys.js";
import { readSessionAuth } from "#context/session-auth.js";
import { senderLine } from "#harness/sender-line.js";
import { stepCatalog } from "#definitions/step.js";
import { forgetFinishedRuns, runtimeResultCalls } from "#harness/coordination.js";
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
import { isEmptyInput } from "#harness/hitl/index.js";
import { readClientContext } from "#internal/client-context.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { Step } from "./context.js";
import type { TokenUsage } from "#shared/token-usage.js";

/**
 * Settles the calls the runtime ran for parked steps. While some still run, the step only weighs
 * what else it brings, such as a person's action on a call that waits as a task, and returns
 * `undefined` when it brings nothing else. Otherwise returns the step's input without the results
 * it settled, and whether the step waited on any.
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
  if (ready === undefined) {
    // A sign-in's callback leaves the step no input, yet the call that stopped for it runs now.
    const signedIn = (step.config.signInCompletions?.length ?? 0) > 0;
    if (input === undefined) return signedIn ? { input, waited: true } : undefined;
    const { delegatedUsage: _usage, runtimeActionResults: _results, ...action } = input;
    return isEmptyInput(action) && !signedIn ? undefined : { input: action, waited: true };
  }
  const finished = forgetFinishedRuns(step.session, ready, runtime.event.turnId);
  step.session = finished.session;
  await step.apply(finishRun(step.view(), { requestIds: finished.requestIds }));
  const results = await runtimeResultCalls(ready, await stepCatalog(step));
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
  /** Who sent the message, when a person did: the model is told when the speaker changes. */
  readonly sender?: SessionAuthContext | null;
  /**
   * Who spoke last once the message joins: its sender, or in a delegated session the delegating
   * turn's latest sender. Absent when the input carries no new message.
   */
  readonly spokeLast?: SessionAuthContext | null;
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
  const continuation = staged !== undefined && isContinuation(step, input);
  const spokeLast =
    staged !== undefined && kind === undefined && !continuation
      ? readSessionAuth(step.ctx).sender
      : undefined;
  // A delegated session's messages come from the agent that called it, not from a person.
  const sender = step.ctx.get(ParentSessionKey) === undefined ? spokeLast : undefined;
  if (staged !== undefined) {
    if (continuation) {
      messages.push(
        anchorToTurn(createFrameworkUserMessage("context.instruction", CONTINUATION_NOTE), turnId),
      );
    }
    const line = sender === undefined ? undefined : senderLine(step.session.state, sender);
    if (line !== undefined) {
      messages.push(anchorToTurn(createFrameworkUserMessage("context.instruction", line), turnId));
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
    ...(sender !== undefined && { sender }),
    ...(spokeLast !== undefined && { spokeLast }),
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

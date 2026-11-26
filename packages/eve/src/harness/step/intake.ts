import {
  stageAttachmentsToSandbox,
  stageHistoryAttachments,
  stageToolResultMedia,
} from "#harness/attachment-staging.js";
import { stepCatalog } from "#definitions/step.js";
import { forgetFinishedRuns, runtimeResultCalls } from "#harness/coordination.js";
import { endsTurnTools } from "#harness/model-call/tools.js";
import { callsEndTurn } from "#harness/step/after-model.js";
import {
  anchorToTurn,
  createFrameworkUserMessage,
  createImportedHistoryMessages,
  createUserMessage,
  followsToolResults,
  frameworkMessageKindForStepInput,
  type HarnessModelMessage,
  normalizeMessage,
  userContentOf,
  TOOL_RESULT_BOUNDARY,
  type UserModelMessage,
} from "#harness/messages.js";
import { finishRun, settle } from "#harness/session-machine/transitions.js";
import { recordLateSpend as recordLateSpendFact } from "#harness/session-machine/runs.js";
import { activeTurnId, parkedCallsAnswered, runtimeWait } from "#harness/session-machine/view.js";
import { stepCallIds } from "#harness/session-machine/suspended-steps.js";
import { getTurnClientContextState } from "#harness/turn-client-context.js";
import type { HarnessStepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { Step } from "./context.js";
import type { TokenUsage } from "#shared/token-usage.js";

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
  const view = step.view();
  const rawResultCalls = new Set([
    ...view.turn.suspended.flatMap((parked) =>
      parked.program === undefined ? [] : [...stepCallIds(parked)],
    ),
    ...ready.flatMap((result) =>
      view.projection.view.calls[result.callId]?.taskId !== undefined ? [result.callId] : [],
    ),
  ]);
  const results = await runtimeResultCalls(ready, catalog, rawResultCalls);
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
  const settledIds = new Set(results.map(({ part }) => part.toolCallId));
  const endsTurn =
    suspended.length > 0 &&
    parkedCallsAnswered(suspended, settledIds) &&
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

async function recordLateSpend(
  step: Step,
  usage: Readonly<Record<string, TokenUsage>> | undefined,
  settled: ReadonlySet<string>,
): Promise<void> {
  const late = Object.entries(usage ?? {}).filter(([callId]) => !settled.has(callId));
  if (late.length > 0) await step.publish(recordLateSpendFact(late.map(([, spent]) => spent)));
}

export interface TurnInput {
  readonly turnId: string;
  readonly clientContext: readonly string[] | undefined;
  readonly storedClientContext: ReturnType<typeof getTurnClientContextState>;
  readonly ephemeral: readonly UserModelMessage[];
  readonly messages: readonly HarnessModelMessage[];
  readonly hasUserMessage: boolean;
  readonly message: HarnessStepInput["message"];
}

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
  const imported = await stageHistoryAttachments(
    createImportedHistoryMessages(input?.history ?? [], step.session.history),
  );
  const messages: HarnessModelMessage[] = [
    ...imported,
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
  const hasUserMessage = staged !== undefined && kind === undefined;
  if (hasUserMessage && followsToolResults(imported)) {
    messages.splice(imported.length, 0, { content: TOOL_RESULT_BOUNDARY, role: "assistant" });
  }
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
    hasUserMessage,
    message: staged as HarnessStepInput["message"],
    messages,
    storedClientContext,
    turnId,
  };
}

const CONTINUATION_NOTE =
  "The next message was sent automatically after the last turn, not by a person.";

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

export function followingToolResults(turn: TurnInput): HarnessModelMessage[] {
  return [
    ...(turn.hasUserMessage ? [{ content: TOOL_RESULT_BOUNDARY, role: "assistant" } as const] : []),
    ...turn.messages,
  ];
}

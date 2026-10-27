import type { ToolResultPart } from "ai";
import { appendTaskContext } from "#execution/tasks/model-step.js";
import { isTaskWorking, readTaskTable, type TaskRecord } from "#execution/tasks/table.js";
import { isToolResultError } from "#harness/action-result-helpers.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { readEndingStubCalls } from "#tool-stubs/ending-calls.js";
import { settleTurnWithoutReply } from "./after-model.js";
import type { Step } from "./context.js";
import { recordStepEndingStubCalls } from "./stub-ending-calls.js";
import type { TurnInput } from "./intake.js";

/** What the turn does next because tool stubs answered the model's last step with `endsTurn`. */
export type StubTurnEnd =
  | { readonly kind: "settle" }
  | { readonly kind: "wait"; readonly taskIds: readonly string[] };

/**
 * Ends the turn when every call of the model's last step got a tool stub's `endsTurn` response or
 * is a call to an `endsTurn` tool, since the model would read only their results; while tasks those
 * calls started still work, the turn waits for them instead. Undefined when the model runs as usual,
 * including while any other task works or has a result the model hasn't read.
 */
export function stubTurnEnd(
  session: HarnessSession,
  turnId: string,
  endsTurnTool: (name: string) => boolean,
): StubTurnEnd | undefined {
  if (session.outputSchema !== undefined) return undefined;
  const ending = readEndingStubCalls(session.state, turnId);
  if (ending.size === 0) return undefined;
  const calls = lastStepCalls(session.history);
  if (
    calls === undefined ||
    ![...calls].every(
      ([callId, { output, toolName }]) =>
        (ending.has(callId) || endsTurnTool(toolName)) &&
        output !== undefined &&
        !isToolResultError(output),
    )
  ) {
    return undefined;
  }
  const open = readTaskTable(session.state).tasks.filter(
    (record) => isTaskWorking(record) || record.results.length > 0,
  );
  if (!open.every((record) => startedBy(record, calls))) return undefined;
  const working = open.filter(isTaskWorking);
  if (working.length > 0) return { kind: "wait", taskIds: working.map(({ id }) => id) };
  if (open.some((record) => record.results.some((result) => result.status !== "completed"))) {
    return undefined;
  }
  return { kind: "settle" };
}

/** Applies {@link stubTurnEnd} before the model's next step, unless a person's message arrived. */
export async function endTurnAfterStubs(
  step: Step,
  turn: TurnInput,
): Promise<StepResult | undefined> {
  recordStepEndingStubCalls(step);
  if (step.hasDelegatedCaller || turn.hasUserMessage) return undefined;
  const end = stubTurnEnd(
    step.session,
    activeTurnId(step.position()),
    (name) => step.config.tools.get(name)?.endsTurn === true,
  );
  if (end === undefined) return undefined;
  if (end.kind === "wait") {
    return { held: { kind: "tasks", taskIds: end.taskIds }, next: null, session: step.session };
  }
  const { history } = step.session;
  const delivered = await appendTaskContext({
    messages: history,
    session: step.session,
    tools: step.config.tools,
  });
  step.session = delivered.session;
  return await settleTurnWithoutReply(step, [...history, ...delivered.messages]);
}

/** The calls the latest assistant message made, with their outputs, by call ID; undefined without calls. */
function lastStepCalls(
  history: readonly HarnessModelMessage[],
):
  | ReadonlyMap<
      string,
      { readonly output: ToolResultPart["output"] | undefined; readonly toolName: string }
    >
  | undefined {
  const index = history.findLastIndex((message) => message.role === "assistant");
  const message = history[index];
  if (message === undefined || typeof message.content === "string") return undefined;
  const calls = new Map<
    string,
    { output: ToolResultPart["output"] | undefined; readonly toolName: string }
  >();
  for (const part of message.content) {
    if (part.type === "tool-call") {
      calls.set(part.toolCallId, { output: undefined, toolName: part.toolName });
    }
  }
  if (calls.size === 0) return undefined;
  for (const later of history.slice(index + 1)) {
    if (later.role !== "tool") continue;
    for (const part of later.content) {
      const call = part.type === "tool-result" ? calls.get(part.toolCallId) : undefined;
      if (call !== undefined && part.type === "tool-result") call.output = part.output;
    }
  }
  return calls;
}

function startedBy(record: TaskRecord, calls: ReadonlyMap<string, unknown>): boolean {
  return (
    record.calls.some((call) => calls.has(call.callId)) ||
    record.results.some((result) => result.calls?.some((call) => calls.has(call.callId)))
  );
}

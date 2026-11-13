import { asSchema, type ModelMessage, type ToolSet, type TypedToolCall } from "ai";

import { stepCatalog } from "#definitions/step.js";
import { isWorkflowTool } from "#execution/tasks/model-step.js";
import { createPresentedRuntimeActionRequestFromToolCall } from "#harness/action-presentation.js";
import { stageToolResultMedia } from "#harness/attachment-staging.js";
import { executeInlineCalls } from "#harness/call-executor.js";
import { enforceBudget, humanInputContext } from "#harness/hitl/index.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { extractToolResultCallIds } from "#harness/model-call/response.js";
import { requestCalls } from "#harness/session-machine/calls.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import type { Step } from "#harness/step/context.js";
import { parkCalls } from "#harness/step/park-calls.js";
import { isRunnableTool } from "#harness/tools.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { StepResult } from "#harness/types.js";
import type { HarnessAction } from "#public/definitions/harness.js";
import { toModelSchema } from "#tools/schema.js";
import { failHarness } from "./kernel.js";
import { HARNESS_CALL_ID_PREFIX } from "./shown-calls.js";

// Calls a harness makes itself, such as a slash command's: requested under the turn (not a model
// run), validated against their tools' schemas, and run through the same gate as the model's, so
// approval, sign-in, and workflow tools all behave as they do for a model's call. When they
// settle, the harness decides again: the kernel asks `next` before the model whenever the latest
// results are a harness's.

type Calls = Extract<HarnessAction, { call: unknown }>["call"];

/** How many calls a harness can make in one turn before the kernel fails it. */
export const MAX_HARNESS_CALLS = 50;

export async function runHarnessCalls(step: Step, calls: Calls): Promise<StepResult> {
  if (calls.length === 0) {
    return await failHarness(step, "HARNESS_INVALID", "The harness asked for no calls.");
  }
  // Calls spend as a model call would: the session's usage limit stands before them too.
  const overBudget = await enforceBudget(step, step.session.history);
  if (overBudget !== undefined) return overBudget;
  const catalog = await stepCatalog(step);
  const turnId = activeTurnId(step.position());
  const made = harnessCallIds(step, turnId).size;
  if (made + calls.length > MAX_HARNESS_CALLS) {
    return await failHarness(
      step,
      "HARNESS_CALL_LIMIT",
      `The harness made more than ${MAX_HARNESS_CALLS} calls in one turn.`,
    );
  }
  const toolCalls: TypedToolCall<ToolSet>[] = [];
  for (const [index, call] of calls.entries()) {
    const refused = (why: string) =>
      failHarness(step, "HARNESS_INVALID", `The harness called "${call.tool}", ${why}.`);
    // eve's own tools reach other tools: a harness calls those by name, through their own gate.
    if (call.tool.startsWith("eve__")) return await refused("an eve tool; call what it reaches");
    const definition = catalog.get(call.tool);
    if (definition === undefined) return await refused("which isn't a tool here");
    // A provider-run tool answers only inside its model call: nothing here would answer it.
    if (!isRunnableTool(definition) && !isWorkflowTool(definition)) {
      return await refused("which only the model's provider runs");
    }
    const checked = await asSchema(toModelSchema(definition.inputSchema, "input")).validate?.(
      call.input ?? {},
    );
    if (checked?.success === false) return await refused("with input its schema rejects");
    toolCalls.push({
      input: checked === undefined ? (call.input ?? {}) : checked.value,
      toolCallId: `${HARNESS_CALL_ID_PREFIX}${turnId.replace(/[^\w-]/g, "_")}_${made + index}`,
      toolName: call.tool,
      type: "tool-call",
    } as TypedToolCall<ToolSet>);
  }
  await step.apply(
    requestCalls(
      toolCalls.map((toolCall) => {
        const { action, hidden, presentationLabel } =
          createPresentedRuntimeActionRequestFromToolCall({ toolCall, tools: catalog });
        return {
          action,
          ...(hidden === true && { hidden }),
          ...(presentationLabel !== undefined && { label: presentationLabel }),
          owner: { turnId },
        };
      }),
    ),
  );
  const results = await executeInlineCalls({
    abortSignal: step.config.abortSignal,
    approvalMemory: humanInputContext(step).approvalMemory,
    beforeExecute: () => {},
    excludedCallIds: new Set(),
    messages: [...step.session.history],
    publish: step.publish,
    toolCalls,
    tools: catalog,
  });
  // A cancelled turn settles its calls itself, so whatever a cut call returned is dropped.
  throwIfTurnAborted(step.config.abortSignal);
  const messages: ModelMessage[] = await stageToolResultMedia([
    {
      content: toolCalls.map(({ input, toolCallId, toolName }) => ({
        input,
        toolCallId,
        toolName,
        type: "tool-call" as const,
      })),
      role: "assistant",
    },
    ...(results.parts.length === 0 ? [] : [{ content: [...results.parts], role: "tool" as const }]),
  ]);
  const answered = extractToolResultCallIds(messages);
  const asked = new Set(results.approvals.map((ask) => ask.call.callId));
  const parked = await parkCalls(step, {
    approvalRequests: results.approvals,
    authorizationInterrupt: resolveInlineAuthorizationInterrupt({ signIns: results.signIns }),
    catalog,
    messages: () => messages,
    ...(results.policyApprovals !== undefined && { policyApprovals: results.policyApprovals }),
    promptMessages: step.session.history,
    workflowToolCalls: toolCalls.filter(
      (call) =>
        !answered.has(call.toolCallId) &&
        !asked.has(call.toolCallId) &&
        isWorkflowTool(catalog.get(call.toolName)),
    ),
  });
  if (parked !== undefined) return parked;
  step.session = changeHistory(step.session, { append: messages });
  // The next step asks the harness again, with these calls settled.
  return { next: step.runStep, session: step.session };
}

/** The calls the harness made in `turnId`, by id. */
export function harnessCallIds(step: Step, turnId: string): ReadonlySet<string> {
  return new Set(
    Object.values(step.view().projection.view.calls)
      .filter((row) => "turnId" in row.owner && row.owner.turnId === turnId)
      .map((row) => row.callId),
  );
}

/**
 * Whether the history ends on the results of calls the harness made: the harness reads them
 * before the model does, as it does new input.
 */
export function endsOnHarnessResults(step: Step): boolean {
  const last = step.session.history.at(-1);
  if (last?.role !== "tool") return false;
  const turnId = activeTurnId(step.position());
  const ids = harnessCallIds(step, turnId);
  const results = [...extractToolResultCallIds([last])];
  return results.length > 0 && results.every((id) => ids.has(id));
}

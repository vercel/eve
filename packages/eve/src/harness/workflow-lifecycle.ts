import type { ToolSet, TypedToolCall } from "ai";

import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import {
  collectActionPresentation,
  createPresentedRuntimeActionRequestFromToolCall,
} from "#harness/action-presentation.js";
import type { HarnessEmitFn, HarnessToolMap } from "#harness/types.js";
import { createActionResultEvent, createActionsRequestedEvent } from "#protocol/message.js";
import type { WorkflowSandboxInterrupt } from "#shared/workflow-sandbox.js";
import {
  getWorkflowSandboxInterrupt,
  type WorkflowSandboxContinuationSecurity,
} from "#shared/workflow-sandbox.js";

export function createWorkflowLifecycle(input: {
  readonly emit: EmitWorkflowLifecycleEvent;
  readonly emissionState: HarnessEmissionState;
  readonly skipReplayed?: boolean;
  readonly tools: HarnessToolMap;
}): {
  onAfterExecute?: (input: { readonly result: unknown }) => Promise<void>;
} {
  return {
    async onAfterExecute(result) {
      if (input.skipReplayed) return;
      const interrupt = await getWorkflowSandboxInterrupt(
        result.result,
        {} as WorkflowSandboxContinuationSecurity,
      );
      if (interrupt === undefined) return;
      await emitWorkflowActionsRequested({
        emit: input.emit,
        emissionState: input.emissionState,
        interrupts: [interrupt],
        tools: input.tools,
      });
    },
  };
}

type EmitWorkflowLifecycleEvent = HarnessEmitFn;

/** Projects newly parked workflow calls onto eve's existing action stream. */
export async function emitWorkflowActionsRequested(input: {
  readonly emit: EmitWorkflowLifecycleEvent;
  readonly emissionState: HarnessEmissionState;
  readonly interrupts: readonly WorkflowSandboxInterrupt[];
  readonly tools: HarnessToolMap;
}): Promise<void> {
  for (const interrupt of input.interrupts) {
    const toolCall = {
      input: interrupt.input,
      toolCallId: interrupt.toolCallId,
      toolName: interrupt.toolName,
      type: "tool-call",
    } as TypedToolCall<ToolSet>;

    const projection = createPresentedRuntimeActionRequestFromToolCall({
      toolCall,
      tools: input.tools,
    });
    await input.emit(
      createActionsRequestedEvent({
        actions: [projection.action],
        presentation: collectActionPresentation([projection]),
        sequence: input.emissionState.sequence,
        stepIndex: input.emissionState.stepIndex,
        turnId: input.emissionState.turnId,
      }),
    );
  }
}

/** Projects completed workflow children before replaying their continuation. */
export async function emitWorkflowActionResults(input: {
  readonly emit: EmitWorkflowLifecycleEvent;
  readonly emissionState: HarnessEmissionState;
  readonly interrupts: readonly WorkflowSandboxInterrupt[];
  readonly results: readonly { readonly isError?: boolean; readonly output?: unknown }[];
}): Promise<void> {
  for (const [index, result] of input.results.entries()) {
    const interrupt = input.interrupts[index];
    if (interrupt === undefined) break;

    await input.emit(
      createActionResultEvent({
        result: createRuntimeToolResultFromValue({
          callId: interrupt.toolCallId,
          isError: result.isError,
          output: result.output,
          toolName: interrupt.toolName,
        }),
        sequence: input.emissionState.sequence,
        stepIndex: input.emissionState.stepIndex,
        turnId: input.emissionState.turnId,
      }),
    );
  }
}

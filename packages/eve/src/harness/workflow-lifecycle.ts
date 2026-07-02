import type { ToolSet, TypedToolCall } from "ai";

import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/runtime-actions.js";
import type { HarnessToolMap } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";
import { toErrorMessage } from "#shared/errors.js";
import type { WorkflowSandboxLifecycle } from "#shared/workflow-sandbox.js";

const log = createLogger("harness.workflow-lifecycle");

type EmitWorkflowLifecycleEvent = (event: HandleMessageStreamEvent) => Promise<void>;

/** Projects sandboxed subagent calls onto eve's existing action event stream. */
export function createWorkflowLifecycle(input: {
  readonly emit: EmitWorkflowLifecycleEvent;
  readonly emissionState: HarnessEmissionState;
  readonly skipReplayed?: boolean;
  readonly tools: HarnessToolMap;
}): WorkflowSandboxLifecycle {
  return {
    onHookError(error, event) {
      log.warn("workflow lifecycle hook failed", {
        error,
        hook: event.hook,
      });
    },
    async onNestedToolCall(event) {
      if (input.skipReplayed === true && event.replayed) return;

      const toolCall = {
        input: event.input,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        type: "tool-call",
      } as TypedToolCall<ToolSet>;

      await input.emit(
        createActionsRequestedEvent({
          actions: [createRuntimeActionRequestFromToolCall({ toolCall, tools: input.tools })],
          sequence: input.emissionState.sequence,
          stepIndex: input.emissionState.stepIndex,
          turnId: input.emissionState.turnId,
        }),
      );
    },
    async onNestedToolResult(event) {
      if (input.skipReplayed === true && event.replayed) return;
      if (event.status === "interrupted") return;

      const result = createRuntimeToolResultFromValue({
        callId: event.toolCallId,
        output: event.status === "rejected" ? toErrorMessage(event.error) : event.output,
        toolName: event.toolName,
        isError: event.status === "rejected",
      });

      await input.emit(
        createActionResultEvent({
          result,
          sequence: input.emissionState.sequence,
          stepIndex: input.emissionState.stepIndex,
          turnId: input.emissionState.turnId,
        }),
      );
    },
  };
}

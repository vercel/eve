import type { ToolSet, TypedToolCall } from "ai";

import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { createLogger } from "#internal/logging.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/runtime-actions.js";
import type { HarnessToolMap } from "#harness/types.js";
import { toErrorMessage } from "#shared/errors.js";
import type { CodeModeOptions } from "#shared/code-mode.js";

const log = createLogger("harness.code-mode-lifecycle");

type EmitCodeModeLifecycleEvent = (event: HandleMessageStreamEvent) => Promise<void>;

/**
 * Builds code-mode lifecycle hooks that project nested host tool calls onto
 * eve's existing action event stream.
 */
export function createCodeModeLifecycle(input: {
  readonly emit: EmitCodeModeLifecycleEvent;
  readonly emissionState: HarnessEmissionState;
  readonly skipReplayed?: boolean;
  readonly tools: HarnessToolMap;
}): NonNullable<CodeModeOptions["lifecycle"]> {
  // No context plumbing here on purpose. The package dispatches these lifecycle
  // hooks from the same pooled-worker bridge as host-tool `execute`, and re-enters
  // the originating invocation's `AsyncLocalStorage` context before doing so
  // (experimental-ai-sdk-code-mode >= 1.0.11). So `emit` and any hook it triggers
  // already write to the running session's `defineState`; this projection stays
  // context-transparent.
  return {
    onHookError(error, event) {
      log.warn("code-mode lifecycle hook failed", {
        error,
        hook: event.hook,
      });
    },
    async onNestedToolCall(event) {
      if (input.skipReplayed === true && event.replayed) {
        return;
      }

      const toolCall = {
        input: event.input,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        type: "tool-call",
      } as TypedToolCall<ToolSet>;

      await input.emit(
        createActionsRequestedEvent({
          actions: [
            createRuntimeActionRequestFromToolCall({
              toolCall,
              tools: input.tools,
            }),
          ],
          sequence: input.emissionState.sequence,
          stepIndex: input.emissionState.stepIndex,
          turnId: input.emissionState.turnId,
        }),
      );
    },
    async onNestedToolResult(event) {
      if (input.skipReplayed === true && event.replayed) {
        return;
      }

      if (event.status === "interrupted") {
        return;
      }

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

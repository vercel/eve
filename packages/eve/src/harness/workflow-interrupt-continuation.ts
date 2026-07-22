import type { ModelMessage } from "ai";
import { createLogger, logError } from "#internal/logging.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { classifyParkedSession } from "#harness/step-result.js";
import type { GenerateOutcome, HarnessSession, GenerateConfig } from "#harness/types.js";
import { getWorkflowContinuationSecurity } from "#harness/workflow-continuation-security.js";
import {
  clearPendingWorkflowInterrupt,
  getPendingWorkflowInterrupt,
  setPendingWorkflowInterrupt,
} from "#harness/workflow-interrupt-state.js";
import { createWorkflowLifecycle } from "#harness/workflow-lifecycle.js";
import {
  getWorkflowRuntimeActionInterrupts,
  isWorkflowRuntimeActionInterrupt,
} from "#harness/workflow-runtime-action-state.js";
import {
  buildWorkflowHostTools,
  resolveWorkflowSandboxBridgeRequestLimit,
} from "#harness/workflow-sandbox.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  continueWorkflowSandboxInterrupt,
  unwrapWorkflowSandboxResult,
  type WorkflowSandboxInterrupt,
} from "#shared/workflow-sandbox.js";

const log = createLogger("harness.generate");

/** Replays a parked dynamic workflow with completed child-agent results. */
export async function continuePendingWorkflowInterrupt(input: {
  readonly childResults?: readonly { readonly output?: unknown }[];
  readonly config: GenerateConfig;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly session: HarnessSession;
}): Promise<GenerateOutcome | null> {
  const pending = getPendingWorkflowInterrupt(input.session.state);
  if (pending === undefined) return null;

  const interrupt = pending.interrupt;
  if (!isWorkflowRuntimeActionInterrupt(interrupt)) {
    throw new Error(`Unsupported Workflow interrupt kind "${interrupt.payload.kind}".`);
  }

  const lifecycle =
    input.emit === undefined
      ? undefined
      : createWorkflowLifecycle({
          emit: input.emit,
          emissionState: input.emissionState,
          skipReplayed: true,
          tools: input.config.tools,
        });
  const continuationSecurity = getWorkflowContinuationSecurity(input.session);

  let continuationOutput: unknown;
  try {
    const hostTools = buildWorkflowHostTools({
      tools: input.config.tools,
    });

    const childResults = input.childResults ?? [];
    let currentInterrupt = interrupt;
    let resultIndex = 0;
    // Promise.all can park several child calls together. Resolve one ledger
    // entry per replay until every supplied child result has been consumed.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      continuationOutput = await continueWorkflowSandboxInterrupt({
        bridgeRequestLimit: resolveWorkflowSandboxBridgeRequestLimit(
          input.config.workflowMaxSubagents,
        ),
        continuationSecurity,
        interrupt: currentInterrupt,
        lifecycle,
        resolution: childResults[resultIndex]?.output,
        tools: hostTools,
      });
      const loopUnwrapped = await unwrapWorkflowSandboxResult(
        continuationOutput,
        continuationSecurity,
      );
      if (loopUnwrapped.status !== "interrupted") break;
      if (!isWorkflowRuntimeActionInterrupt(loopUnwrapped.interrupt)) break;
      if (resultIndex + 1 >= childResults.length) break;
      const nextInterrupt = getWorkflowRuntimeActionInterrupts(loopUnwrapped.interrupt)[0];
      if (nextInterrupt === undefined) {
        throw new Error("Workflow continuation contains no pending runtime-action interrupt.");
      }
      resultIndex++;
      currentInterrupt = nextInterrupt;
    }
  } catch (error) {
    logError(log, "Workflow interrupt continuation failed", error);
    continuationOutput = {
      error: "workflow_continuation_failed",
      message: toErrorMessage(error),
      retryable: false,
    };
  }

  const unwrapped = await unwrapWorkflowSandboxResult(continuationOutput, continuationSecurity);
  const finalOutput = unwrapped.status === "interrupted" ? unwrapped.interrupt : unwrapped.output;
  const baseMessages = [...input.session.history, ...pending.responseMessages];
  const replacedMessages = replaceWorkflowToolResult(
    baseMessages,
    (interrupt as { outerToolCallId?: string }).outerToolCallId,
    finalOutput,
  );

  let session = clearPendingWorkflowInterrupt({
    ...input.session,
    history: replacedMessages,
  });

  if (unwrapped.status === "interrupted") {
    if (!isWorkflowRuntimeActionInterrupt(unwrapped.interrupt)) {
      throw new Error(`Unsupported Workflow interrupt kind "${unwrapped.interrupt.payload.kind}".`);
    }
    const promptMessageCount = input.session.history.length;
    const promptMessages = replacedMessages.slice(0, promptMessageCount);
    const responseMessages = replacedMessages.slice(promptMessageCount);
    session = { ...session, history: promptMessages };
    return parkOnWorkflowInterrupt({
      baseSession: session,
      emissionState: input.emissionState,
      interrupt: unwrapped.interrupt,
      promptMessages,
      responseMessages,
    });
  }

  return { action: "continue", state: session };
}

function replaceWorkflowToolResult(
  messages: readonly ModelMessage[],
  outerToolCallId: string | undefined,
  output: unknown,
): ModelMessage[] {
  if (outerToolCallId === undefined) return [...messages];
  const outputValue =
    typeof output === "string"
      ? { type: "text" as const, value: output }
      : { type: "json" as const, value: output };
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const content = (message.content as readonly { type: string; toolCallId?: string }[]).map(
      (part) => {
        if (part.type !== "tool-result" || part.toolCallId !== outerToolCallId) return part;
        return { ...part, output: outputValue };
      },
    );
    return { ...message, content };
  }) as ModelMessage[];
}

export function parkOnWorkflowInterrupt(input: {
  readonly baseSession: HarnessSession;
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly interrupt: WorkflowSandboxInterrupt;
  readonly promptMessages: readonly ModelMessage[];
  readonly responseMessages: readonly ModelMessage[];
}): GenerateOutcome {
  const interrupt = getWorkflowRuntimeActionInterrupts(input.interrupt)[0];
  if (interrupt === undefined) {
    throw new Error("Workflow continuation contains no pending runtime-action interrupt.");
  }

  const baseSession: HarnessSession = {
    ...input.baseSession,
    history: [...input.promptMessages],
  };

  const parkedSession = setPendingWorkflowInterrupt({
    interrupt,
    responseMessages: input.responseMessages,
    session: baseSession,
  });

  return classifyParkedSession(setHarnessEmissionState(parkedSession, input.emissionState));
}

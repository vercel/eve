import { FatalError, RetryableError } from "#compiled/@workflow/core/index.js";
import type { RunLimits } from "#compiled/run/index.js";
import {
  WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
  WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES,
  readWorkflowProgramAgentCall,
  type WorkflowProgramAgentCall,
  type WorkflowProgramCallResult,
  type WorkflowProgramInput,
  type WorkflowProgramPendingCall,
  type WorkflowProgramResolution,
} from "#execution/dynamic-workflow/schema.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { loadWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

export type WorkflowProgramStepOutcome =
  | { readonly output: JsonValue; readonly status: "completed" }
  | {
      readonly continuation: string;
      readonly pending: readonly WorkflowProgramPendingCall[];
      readonly status: "interrupted";
    };

interface WorkflowProgramStepInput {
  readonly callId: string;
  readonly program: WorkflowProgramInput;
  readonly resume?: {
    readonly continuation: string;
    readonly resolutions: readonly WorkflowProgramResolution[];
  };
}

const WORKFLOW_PROGRAM_CONTINUATION_AUDIENCE = "eve.workflow-program/v1";
const WORKFLOW_PROGRAM_HOST_NAMESPACE = "__eveWorkflowProgram";
const WORKFLOW_PROGRAM_MAX_JSON_BYTES = 1024 * 1024;
const WORKFLOW_PROGRAM_MAX_SOURCE_BYTES = 256 * 1024;
const WORKFLOW_PROGRAM_CPU_TIMEOUT_MS = 30_000;
const WORKFLOW_PROGRAM_TIMEOUT_MS = 300_000;

function wrapWorkflowProgram(js: string): string {
  return `const ctx = Object.freeze({ agent: (target, input) => ${WORKFLOW_PROGRAM_HOST_NAMESPACE}.agent(JSON.stringify({ target, input })) }); return JSON.stringify(await (async () => {${js}\n})());`;
}

const runEncodingLimit = (jsonBytes: number) => jsonBytes * 6 + 1024;

const WORKFLOW_PROGRAM_BUSY_RETRY_MS = 5_000;

const WORKFLOW_PROGRAM_LIMITS: RunLimits = {
  cpuTimeoutMs: WORKFLOW_PROGRAM_CPU_TIMEOUT_MS,
  maxBridgeRequests: WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
  maxConsoleOutputBytes: 64 * 1024,
  maxHostFunctionArgumentsBytes: runEncodingLimit(WORKFLOW_PROGRAM_MAX_JSON_BYTES),
  maxHostFunctionOutputBytes: runEncodingLimit(WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES),
  maxInFlightBridgeRequests: WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
  maxResultBytes: runEncodingLimit(WORKFLOW_PROGRAM_MAX_JSON_BYTES),
  maxSourceBytes: WORKFLOW_PROGRAM_MAX_SOURCE_BYTES + wrapWorkflowProgram("").length,
  maxStackSizeBytes: 2 * 1024 * 1024,
  memoryLimitBytes: 64 * 1024 * 1024,
  timeoutMs: WORKFLOW_PROGRAM_TIMEOUT_MS,
};

export async function runWorkflowProgramStep(
  input: WorkflowProgramStepInput,
): Promise<WorkflowProgramStepOutcome> {
  "use step";

  try {
    return await runWorkflowProgram(input);
  } catch (error) {
    if (RetryableError.is(error)) throw error;
    throw new FatalError(toErrorMessage(error));
  }
}

async function runWorkflowProgram(
  input: WorkflowProgramStepInput,
): Promise<WorkflowProgramStepOutcome> {
  const sourceBytes = Buffer.byteLength(input.program.js);
  if (sourceBytes > WORKFLOW_PROGRAM_MAX_SOURCE_BYTES) {
    throw new RangeError(
      `Workflow program source is ${String(sourceBytes)} bytes, over the ${String(WORKFLOW_PROGRAM_MAX_SOURCE_BYTES)} byte limit.`,
    );
  }
  const { createRunner, createSignedContinuationCodec, getHostFunctionContext, RunError } =
    await loadWorkflowSandboxModule();
  const { maxAgeMs, signingKey } = input.program.continuationSecurity;
  const runner = createRunner({
    continuationAudience: WORKFLOW_PROGRAM_CONTINUATION_AUDIENCE,
    continuationCodec: createSignedContinuationCodec({ maxAgeMs, secret: signingKey }),
  });

  const guestError = (message: string) => {
    const error = new RunError(message, "WORKFLOW_PROGRAM_AGENT_ERROR");
    error.name = "WorkflowProgramAgentError";
    return error;
  };

  const running = runner.run({
    source: wrapWorkflowProgram(input.program.js),
    hostFunctions: {
      [WORKFLOW_PROGRAM_HOST_NAMESPACE]: {
        agent: async (callJson: unknown) => {
          let call: WorkflowProgramAgentCall;
          try {
            call = readWorkflowProgramAgentCall(
              parseWorkflowProgramJson(callJson, "ctx.agent() input"),
            );
          } catch (error) {
            throw guestError(toErrorMessage(error));
          }
          const { interrupt, resume } = getHostFunctionContext();
          if (resume === undefined) return interrupt(call);
          const outcome = resume.resolution as WorkflowProgramCallResult;
          if (outcome.status === "failed") throw guestError(outcome.error);
          return outcome.output;
        },
      },
    },
    limits: WORKFLOW_PROGRAM_LIMITS,
    continuationContext: { callId: input.callId },
    continuation: input.resume?.continuation,
    resolutions: input.resume?.resolutions.slice(),
  });
  const result = await running.catch((error: unknown) => {
    if (!RunError.isInstance(error)) throw error;
    if (error.code === "RUN_CONCURRENCY_LIMIT") {
      throw new RetryableError(error.message, { retryAfter: WORKFLOW_PROGRAM_BUSY_RETRY_MS });
    }
    if (error.code === "RUN_DETACHED_BRIDGE_REQUEST") {
      throw new Error(
        "Workflow program returned while a ctx.agent() call was still pending. Await every ctx.agent() call before returning, including calls passed to Promise.race or Promise.any.",
      );
    }
    throw error;
  });

  if (result.status === "completed") {
    const output =
      result.value === undefined
        ? null
        : parseJsonValue(parseWorkflowProgramJson(result.value, "result"));
    return { output, status: "completed" };
  }
  return {
    continuation: result.continuation,
    pending: result.interruptions.map((interruption) => ({
      call: readWorkflowProgramAgentCall(interruption.payload),
      id: interruption.id,
    })),
    status: "interrupted",
  };
}

function parseWorkflowProgramJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    throw new TypeError(`Workflow program ${label} must be JSON text.`);
  }
  const bytes = Buffer.byteLength(value);
  if (bytes > WORKFLOW_PROGRAM_MAX_JSON_BYTES) {
    throw new RangeError(
      `Workflow program ${label} is ${String(bytes)} bytes of JSON, over the ${String(WORKFLOW_PROGRAM_MAX_JSON_BYTES)} byte limit.`,
    );
  }
  return JSON.parse(value);
}

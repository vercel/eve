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
/** Size limit for the JSON text of a program's result and of each `ctx.agent()` call. */
const WORKFLOW_PROGRAM_MAX_JSON_BYTES = 1024 * 1024;
const WORKFLOW_PROGRAM_MAX_SOURCE_BYTES = 256 * 1024;
/** Guest JavaScript time per run or resume; parked agent calls do not count. */
const WORKFLOW_PROGRAM_CPU_TIMEOUT_MS = 30_000;
/** Wall-clock time per run or resume; parked agent calls do not count. */
const WORKFLOW_PROGRAM_TIMEOUT_MS = 300_000;

/**
 * Converts the program's values to JSON inside the sandbox, where run's limits
 * bound the work. run transfers values with shared references intact, so a
 * small value can expand without limit if the host converts it. The prelude
 * shares the program's first line, so stack line numbers match its source.
 */
function wrapWorkflowProgram(js: string): string {
  return `const ctx = Object.freeze({ agent: (target, input) => ${WORKFLOW_PROGRAM_HOST_NAMESPACE}.agent(JSON.stringify({ target, input })) }); return JSON.stringify(await (async () => {${js}\n})());`;
}

/**
 * run measures values in its own encoding, which can turn one byte of JSON
 * into six (`<` becomes `\u003C`), so run gets the worst-case budget and eve's
 * JSON size checks always fail first, with eve's message.
 */
const runEncodingLimit = (jsonBytes: number) => jsonBytes * 6 + 1024;

/** Gives programs holding the busy workers time to finish before the step retries. */
const WORKFLOW_PROGRAM_BUSY_RETRY_MS = 5_000;

const WORKFLOW_PROGRAM_LIMITS: RunLimits = {
  cpuTimeoutMs: WORKFLOW_PROGRAM_CPU_TIMEOUT_MS,
  maxBridgeRequests: WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
  maxConsoleOutputBytes: 64 * 1024,
  maxHostFunctionArgumentsBytes: runEncodingLimit(WORKFLOW_PROGRAM_MAX_JSON_BYTES),
  maxHostFunctionOutputBytes: runEncodingLimit(WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES),
  maxInFlightBridgeRequests: WORKFLOW_PROGRAM_BRIDGE_REQUEST_LIMIT,
  maxResultBytes: runEncodingLimit(WORKFLOW_PROGRAM_MAX_JSON_BYTES),
  // eve checks the program's own size; the ASCII wrapper's length is its byte count.
  maxSourceBytes: WORKFLOW_PROGRAM_MAX_SOURCE_BYTES + wrapWorkflowProgram("").length,
  maxStackSizeBytes: 2 * 1024 * 1024,
  memoryLimitBytes: 64 * 1024 * 1024,
  timeoutMs: WORKFLOW_PROGRAM_TIMEOUT_MS,
};

/** Runs or resumes the side-effect-free JavaScript sandbox for one durable workflow. */
export async function runWorkflowProgramStep(
  input: WorkflowProgramStepInput,
): Promise<WorkflowProgramStepOutcome> {
  "use step";

  try {
    return await runWorkflowProgram(input);
  } catch (error) {
    // The step has no side effects, so retrying a busy runtime is safe.
    if (RetryableError.is(error)) throw error;
    // The sandbox is deterministic, so any other failure repeats on every retry.
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

  // run shows the program only RunError messages; other host errors read "Host function failed."
  const guestError = (message: string) => {
    const error = new RunError(message, "WORKFLOW_PROGRAM_AGENT_ERROR");
    // RunError takes its name from its class, which the minified vendored bundle renames.
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
    // run has no free worker or worker memory in this process; another attempt can succeed.
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
    // `JSON.stringify` returns undefined for values it drops, such as `undefined` itself.
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

/** Parses JSON text from the prelude; code that bypasses the prelude can send any value. */
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

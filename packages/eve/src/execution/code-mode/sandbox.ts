import type { RunLimits } from "#compiled/run/index.js";
import {
  PROGRAM_CPU_TIMEOUT_MS,
  PROGRAM_MAX_CALLS,
  PROGRAM_MAX_CONSOLE_BYTES,
  PROGRAM_MAX_CONTINUATION_BYTES,
  PROGRAM_MAX_INPUT_BYTES,
  PROGRAM_MAX_OUTPUT_BYTES,
  PROGRAM_MAX_SOURCE_BYTES,
  PROGRAM_MEMORY_BYTES,
  PROGRAM_STACK_BYTES,
  PROGRAM_TIMEOUT_MS,
} from "#execution/code-mode/limits.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { loadWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

// One step of a program, for `eve__execute` and for a `workflow()` tool: the model's JavaScript runs in QuickJS on the vendored
// `run` runtime, with no network, file system, timers, or imports. Its only way out is the host
// bridge below, which the program step answers. A call that can't finish inside the step
// interrupts the program; `run` returns a signed continuation holding every result so far, and a
// later step resumes from it without running a recorded call again.

/** How the model is told to write a program, for every tool that takes one. */
export const PROGRAM_CODE_INPUT_DESCRIPTION =
  "The body of an async function: use `await` and `return` at the top level.";

/** An error the program can catch: its message is what the program reads. */
export class ProgramCallError extends Error {
  override readonly name = "ProgramCallError";
}

/** One bridge request: a `tools.<name>(input)` call or a `search(input)`. */
export interface ProgramRequest {
  /** The request's order in the program, starting at 1 and the same on every resume. */
  readonly index: number;
  /** Stops the program until the step that resumes it supplies this request's resolution. */
  readonly interrupt: () => never;
  /** The resolution the resuming step supplied, when this request interrupted before. */
  readonly resumed?: { readonly resolution: unknown };
}

export interface ProgramSandboxInput {
  /** Binds the program's continuations to its `eve__execute` call. */
  readonly callId: string;
  readonly code: string;
  readonly security: { readonly maxAgeMs?: number; readonly signingKey: string };
  readonly resume?: {
    readonly continuation: string;
    readonly resolutions: readonly { readonly interruptionId: string; readonly value: unknown }[];
  };
  readonly abortSignal?: AbortSignal;
  /** Answers `tools.<name>(input)`: the call's output, or a {@link ProgramCallError}. */
  readonly call: (
    request: ProgramRequest,
    call: { readonly name: string; readonly input: unknown },
  ) => Promise<JsonValue>;
  /** Answers `search(input)`. */
  readonly search: (request: ProgramRequest, input: unknown) => Promise<JsonValue>;
}

export type ProgramSandboxOutcome =
  | { readonly status: "completed"; readonly result: JsonValue; readonly logs: readonly string[] }
  | { readonly status: "failed"; readonly error: string; readonly logs: readonly string[] }
  | {
      readonly status: "interrupted";
      readonly continuation: string;
      /** The requests the program stopped on, by the interruption each raised. */
      readonly pending: readonly { readonly interruptionId: string; readonly index: number }[];
    };

const CONTINUATION_AUDIENCE = "eve.execute/v1";
const HOST_NAMESPACE = "__eve";
/**
 * The lines run puts before the source it evaluates. A stack read inside the sandbox counts
 * them; the prelude shares the program's first line, so the rest is the program's own numbering.
 */
const RUN_SOURCE_LINE_OFFSET = 2;
/** How long a step waits for a free `run` worker before the program fails. */
const BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

/**
 * The program's globals, on the program's first line so stack line numbers match its source.
 * Values cross the bridge as JSON text built inside the sandbox, where run's limits bound the
 * work: run transfers values with shared references intact, so a small value could expand
 * without limit if the host converted it.
 */
const PRELUDE = [
  `const __logs = []; let __logBytes = 0;`,
  `const __text = (value) => { if (typeof value === "string") return value; try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; } catch { return String(value); } };`,
  `const __log = (...args) => { const line = args.map(__text).join(" "); if (__logBytes > ${String(PROGRAM_MAX_CONSOLE_BYTES)}) return; __logBytes += line.length + 1; __logs.push(__logBytes > ${String(PROGRAM_MAX_CONSOLE_BYTES)} ? "(console output truncated)" : line); };`,
  `const console = Object.freeze({ debug: __log, error: __log, info: __log, log: __log, warn: __log });`,
  `const __bridge = (kind, payload) => ${HOST_NAMESPACE}[kind](JSON.stringify(payload)).then(JSON.parse);`,
  `const tools = new Proxy(Object.freeze({}), { get: (_target, name) => typeof name !== "string" || name === "then" || name === "toJSON" ? undefined : (input) => __bridge("call", { name, input: input === undefined ? {} : input }) });`,
  `const search = (input) => __bridge("search", { input });`,
].join(" ");

function wrapProgram(code: string): string {
  return `${PRELUDE} try { const __value = await (async () => {${code}\n})(); return JSON.stringify({ ok: true, value: __value === undefined ? null : __value, logs: __logs }); } catch (__error) { return JSON.stringify({ ok: false, error: { message: __error instanceof Error ? __error.message : __text(__error), name: __error instanceof Error ? __error.name : "", stack: __error instanceof Error ? String(__error.stack ?? "") : "" }, logs: __logs }); }`;
}

/**
 * run measures values in its own encoding, which can turn one byte of JSON into six (`<` becomes
 * `\u003C`), so run gets the worst-case budget and eve's JSON size checks always fail first, with
 * eve's message.
 */
const runEncodingLimit = (jsonBytes: number) => jsonBytes * 6 + 1024;

const LIMITS: RunLimits = {
  cpuTimeoutMs: PROGRAM_CPU_TIMEOUT_MS,
  // The step refuses a call past the limit itself, with an error the program can catch.
  maxBridgeRequests: PROGRAM_MAX_CALLS * 2,
  maxContinuationBytes: PROGRAM_MAX_CONTINUATION_BYTES,
  maxHostFunctionArgumentsBytes: runEncodingLimit(PROGRAM_MAX_INPUT_BYTES),
  maxHostFunctionOutputBytes: runEncodingLimit(PROGRAM_MAX_OUTPUT_BYTES),
  // run fails a program over its in-flight limit instead of queueing; the step queues.
  maxInFlightBridgeRequests: PROGRAM_MAX_CALLS * 2,
  maxResultBytes: runEncodingLimit(PROGRAM_MAX_INPUT_BYTES + 2 * PROGRAM_MAX_CONSOLE_BYTES),
  // eve checks the program's own size; the ASCII wrapper's length is its byte count.
  maxSourceBytes: PROGRAM_MAX_SOURCE_BYTES + wrapProgram("").length,
  maxStackSizeBytes: PROGRAM_STACK_BYTES,
  memoryLimitBytes: PROGRAM_MEMORY_BYTES,
  timeoutMs: PROGRAM_TIMEOUT_MS,
};

/**
 * Runs or resumes a program until it returns, fails, or stops on calls it must wait for. A
 * failure of the program is an outcome, not a throw: only the caller's abort rejects.
 */
export async function runProgramSandbox(
  input: ProgramSandboxInput,
): Promise<ProgramSandboxOutcome> {
  const sourceBytes = Buffer.byteLength(input.code);
  if (sourceBytes > PROGRAM_MAX_SOURCE_BYTES) {
    return failed(
      `EXECUTE_SOURCE_TOO_LARGE: the program is ${String(sourceBytes)} bytes, over the ${String(PROGRAM_MAX_SOURCE_BYTES)} byte limit.`,
    );
  }
  const { createRunner, createSignedContinuationCodec, getHostFunctionContext, RunError } =
    await loadWorkflowSandboxModule();
  const { maxAgeMs, signingKey } = input.security;
  const runner = createRunner({
    continuationAudience: CONTINUATION_AUDIENCE,
    continuationCodec: createSignedContinuationCodec({ maxAgeMs, secret: signingKey }),
  });

  // run shows the program only RunError messages; other host errors read "Host function failed."
  const guestError = (message: string) => {
    const error = new RunError(message, "EXECUTE_CALL_ERROR");
    // RunError takes its name from its class, which the minified vendored bundle renames.
    error.name = "ToolError";
    return error;
  };
  const bridge =
    <T>(
      label: string,
      read: (payload: unknown) => T,
      answer: (request: ProgramRequest, payload: T) => Promise<JsonValue>,
    ) =>
    async (json: unknown): Promise<string> => {
      const context = getHostFunctionContext();
      const request: ProgramRequest = {
        index: context.requestIndex,
        interrupt: () => context.interrupt({ index: context.requestIndex }),
        ...(context.resume !== undefined && { resumed: { resolution: context.resume.resolution } }),
      };
      let payload: T;
      try {
        payload = read(parseBridgeJson(json, label, PROGRAM_MAX_INPUT_BYTES));
      } catch (error) {
        throw guestError(toErrorMessage(error));
      }
      let output: JsonValue;
      try {
        output = await answer(request, payload);
      } catch (error) {
        if (error instanceof ProgramCallError) throw guestError(error.message);
        throw error;
      }
      const text = JSON.stringify(output ?? null);
      const bytes = Buffer.byteLength(text);
      if (bytes > PROGRAM_MAX_OUTPUT_BYTES) {
        throw guestError(
          `EXECUTE_OUTPUT_TOO_LARGE: ${label} returned ${String(bytes)} bytes of JSON, over the ${String(PROGRAM_MAX_OUTPUT_BYTES)} byte limit for one result.`,
        );
      }
      return text;
    };

  const source = wrapProgram(input.code);
  const start = () =>
    runner.run({
      abortSignal: input.abortSignal,
      continuation: input.resume?.continuation,
      continuationContext: { callId: input.callId },
      hostFunctions: {
        [HOST_NAMESPACE]: {
          call: bridge("tools call", readCall, input.call),
          search: bridge("search()", readSearch, input.search),
        },
      },
      limits: LIMITS,
      resolutions: input.resume?.resolutions.map((resolution) => ({ ...resolution })),
      source,
    });

  let result: Awaited<ReturnType<typeof start>>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await start();
      break;
    } catch (error) {
      if (input.abortSignal?.aborted === true) throw input.abortSignal.reason;
      if (!RunError.isInstance(error)) throw error;
      // run has no free worker or worker memory in this process. Nothing of the program ran, so
      // another attempt is safe.
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (error.code === "RUN_CONCURRENCY_LIMIT" && delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return failed(runFailureMessage(error));
    }
  }

  if (result.status === "interrupted") {
    return {
      continuation: result.continuation as string,
      pending: result.interruptions.map((interruption) => ({
        index: (interruption.payload as { readonly index: number }).index,
        interruptionId: interruption.id,
      })),
      status: "interrupted",
    };
  }
  let settled: unknown;
  try {
    settled = parseBridgeJson(
      result.value,
      "result",
      PROGRAM_MAX_INPUT_BYTES + 2 * PROGRAM_MAX_CONSOLE_BYTES,
    );
  } catch (error) {
    return failed(toErrorMessage(error));
  }
  if (!isObject(settled)) return failed("The program returned no result.");
  const logs = Array.isArray(settled.logs) ? settled.logs.map(String) : [];
  if (settled.ok === true) {
    return { logs, result: parseJsonValue(settled.value ?? null), status: "completed" };
  }
  return { error: guestFailureMessage(settled.error), logs, status: "failed" };
}

function failed(error: string): ProgramSandboxOutcome {
  return { error, logs: [], status: "failed" };
}

/** Why run stopped the program, in words the model can act on. */
function runFailureMessage(error: { readonly code: string; readonly message: string }): string {
  switch (error.code) {
    case "RUN_DETACHED_BRIDGE_REQUEST":
      return "The program returned while a tools call was still pending. Await every call before returning, including calls passed to Promise.race or Promise.any.";
    case "RUN_CPU_TIMEOUT":
      return `EXECUTE_CPU_LIMIT_REACHED: the program ran more than ${String(PROGRAM_CPU_TIMEOUT_MS / 1000)} seconds of JavaScript in one step, not counting time spent waiting on calls.`;
    case "RUN_TIMEOUT":
      return `EXECUTE_TIME_LIMIT_REACHED: the program ran for more than ${String(PROGRAM_TIMEOUT_MS / 60_000)} minutes without waiting on a person, an agent, or a workflow.`;
    case "RUN_CONTINUATION_TOO_LARGE":
      return continuationTooLargeMessage();
    case "RUN_CONCURRENCY_LIMIT":
      return "EXECUTE_RUNTIME_BUSY: no program runtime was free. Run the program again.";
    default:
      return /continuation/iu.test(error.message) && /limit|large|exceed/iu.test(error.message)
        ? continuationTooLargeMessage()
        : error.message;
  }
}

function continuationTooLargeMessage(): string {
  return `EXECUTE_CONTINUATION_LIMIT_REACHED: the results the program holds while it waits are over ${String(PROGRAM_MAX_CONTINUATION_BYTES / (1024 * 1024))} MiB. Return less from each call, or make fewer calls per program.`;
}

/** An uncaught error of the program: its message, and the line of the program that threw. */
function guestFailureMessage(error: unknown): string {
  if (!isObject(error)) return "The program failed.";
  const message = typeof error.message === "string" ? error.message : "The program failed.";
  const name = typeof error.name === "string" && error.name !== "" ? `${error.name}: ` : "";
  const frame =
    typeof error.stack === "string" ? /\(run\.js:(\d+):\d+\)/u.exec(error.stack)?.[1] : undefined;
  const line = frame === undefined ? 0 : Number(frame) - RUN_SOURCE_LINE_OFFSET;
  return `${name}${message}${line > 0 ? ` (line ${String(line)})` : ""}`;
}

function readCall(payload: unknown): { readonly name: string; readonly input: unknown } {
  if (!isObject(payload) || typeof payload.name !== "string" || payload.name === "") {
    throw new TypeError("Call a tool as tools.<name>(input), by its exact name.");
  }
  return { input: payload.input, name: payload.name };
}

function readSearch(payload: unknown): unknown {
  return isObject(payload) ? payload.input : undefined;
}

/** Parses JSON text from the prelude; code that bypasses the prelude can send any value. */
function parseBridgeJson(value: unknown, label: string, maxBytes: number): unknown {
  if (typeof value !== "string") throw new TypeError(`The program's ${label} must be JSON text.`);
  const bytes = Buffer.byteLength(value);
  if (bytes > maxBytes) {
    throw new RangeError(
      `EXECUTE_VALUE_TOO_LARGE: the program's ${label} is ${String(bytes)} bytes of JSON, over the ${String(maxBytes)} byte limit.`,
    );
  }
  return JSON.parse(value);
}

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

export class ProgramCallError extends Error {
  override readonly name = "ProgramCallError";
}

export interface ProgramRequest {
  readonly index: number;
  readonly interrupt: () => never;
  readonly resumed?: { readonly resolution: unknown };
}

export interface ProgramSandboxHandler {
  readonly errorCode?: string;
  readonly errorName?: string;
  readonly handle: (request: ProgramRequest, payload: unknown) => Promise<JsonValue>;
  readonly label: string;
}

export interface ProgramSandboxInput {
  readonly abortSignal?: AbortSignal;
  readonly audience?: string;
  readonly callId: string;
  readonly code: string;
  readonly errorCode?: string;
  readonly errorName?: string;
  readonly handlers: Readonly<Record<string, ProgramSandboxHandler>>;
  readonly hostNamespace?: string;
  readonly prelude?: string;
  readonly resume?: {
    readonly continuation: string;
    readonly resolutions: readonly { readonly interruptionId: string; readonly value: unknown }[];
  };
  readonly security: { readonly maxAgeMs?: number; readonly signingKey: string };
}

export type ProgramSandboxOutcome =
  | { readonly logs: readonly string[]; readonly result: JsonValue; readonly status: "completed" }
  | { readonly error: string; readonly logs: readonly string[]; readonly status: "failed" }
  | {
      readonly continuation: string;
      readonly pending: readonly { readonly index: number; readonly interruptionId: string }[];
      readonly status: "interrupted";
    };

const DEFAULT_CONTINUATION_AUDIENCE = "eve.execute/v1";
const DEFAULT_HOST_NAMESPACE = "__eve";
const DEFAULT_ERROR_CODE = "EXECUTE_CALL_ERROR";
const DEFAULT_ERROR_NAME = "WorkflowProgramError";
const RUN_SOURCE_LINE_OFFSET = 2;
const BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];
const LINE_TERMINATOR_RE = /[\r\n\u2028\u2029]/u;

function buildBasePrelude(hostNamespace: string): string {
  return [
    `const __logs = []; let __logBytes = 0;`,
    `const __text = (value) => { if (typeof value === "string") return value; try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; } catch { return String(value); } };`,
    `const __log = (...args) => { const line = args.map(__text).join(" "); if (__logBytes > ${String(PROGRAM_MAX_CONSOLE_BYTES)}) return; __logBytes += line.length + 1; __logs.push(__logBytes > ${String(PROGRAM_MAX_CONSOLE_BYTES)} ? "(console output truncated)" : line); };`,
    `const console = Object.freeze({ debug: __log, error: __log, info: __log, log: __log, warn: __log });`,
    `const __bridge = (kind, payload) => ${hostNamespace}[kind](JSON.stringify(payload)).then(JSON.parse);`,
  ].join(" ");
}

function wrapProgram(code: string, hostNamespace: string, prelude: string | undefined): string {
  const base = buildBasePrelude(hostNamespace);
  const header = prelude !== undefined && prelude.length > 0 ? `${base} ${prelude}` : base;
  return `${header} try { const __value = await (async () => {${code}\n})(); return JSON.stringify({ ok: true, value: __value === undefined ? null : __value, logs: __logs }); } catch (__error) { return JSON.stringify({ ok: false, error: { message: __error instanceof Error ? __error.message : __text(__error), name: __error instanceof Error ? __error.name : "", stack: __error instanceof Error ? String(__error.stack ?? "") : "" }, logs: __logs }); }`;
}

const runEncodingLimit = (jsonBytes: number) => jsonBytes * 6 + 1024;

export async function runProgramSandbox(
  input: ProgramSandboxInput,
): Promise<ProgramSandboxOutcome> {
  if (input.prelude !== undefined && LINE_TERMINATOR_RE.test(input.prelude)) {
    throw new Error("Program sandbox prelude must be a single line.");
  }
  const sourceBytes = Buffer.byteLength(input.code);
  if (sourceBytes > PROGRAM_MAX_SOURCE_BYTES) {
    return failed(
      `EXECUTE_SOURCE_TOO_LARGE: the program is ${String(sourceBytes)} bytes, over the ${String(PROGRAM_MAX_SOURCE_BYTES)} byte limit.`,
    );
  }
  const hostNamespace = input.hostNamespace ?? DEFAULT_HOST_NAMESPACE;
  const audience = input.audience ?? DEFAULT_CONTINUATION_AUDIENCE;
  const defaultErrorCode = input.errorCode ?? DEFAULT_ERROR_CODE;
  const defaultErrorName = input.errorName ?? DEFAULT_ERROR_NAME;
  const { createRunner, createSignedContinuationCodec, getHostFunctionContext, RunError } =
    await loadWorkflowSandboxModule();
  const { maxAgeMs, signingKey } = input.security;
  const runner = createRunner({
    continuationAudience: audience,
    continuationCodec: createSignedContinuationCodec({ maxAgeMs, secret: signingKey }),
  });

  const guestError = (message: string, code: string, name: string) => {
    const error = new RunError(message, code);
    error.name = name;
    return error;
  };

  const bridge =
    (handler: ProgramSandboxHandler) =>
    async (json: unknown): Promise<string> => {
      const context = getHostFunctionContext();
      const request: ProgramRequest = {
        index: context.requestIndex,
        interrupt: () => context.interrupt({ index: context.requestIndex }),
        ...(context.resume !== undefined && { resumed: { resolution: context.resume.resolution } }),
      };
      const code = handler.errorCode ?? defaultErrorCode;
      const name = handler.errorName ?? defaultErrorName;
      let payload: unknown;
      try {
        payload = parseBridgeJson(json, handler.label, PROGRAM_MAX_INPUT_BYTES);
      } catch (error) {
        throw guestError(toErrorMessage(error), code, name);
      }
      let output: JsonValue;
      try {
        output = await handler.handle(request, payload);
      } catch (error) {
        if (error instanceof ProgramCallError) throw guestError(error.message, code, name);
        throw error;
      }
      const text = JSON.stringify(output ?? null);
      const bytes = Buffer.byteLength(text);
      if (bytes > PROGRAM_MAX_OUTPUT_BYTES) {
        throw guestError(
          `EXECUTE_OUTPUT_TOO_LARGE: ${handler.label} returned ${String(bytes)} bytes of JSON, over the ${String(PROGRAM_MAX_OUTPUT_BYTES)} byte limit for one result.`,
          code,
          name,
        );
      }
      return text;
    };

  const hostFunctions: Record<string, (json: unknown) => Promise<string>> = {};
  for (const [name, handler] of Object.entries(input.handlers)) {
    hostFunctions[name] = bridge(handler);
  }

  const emptyWrapper = wrapProgram("", hostNamespace, input.prelude);
  const limits: RunLimits = {
    cpuTimeoutMs: PROGRAM_CPU_TIMEOUT_MS,
    maxBridgeRequests: PROGRAM_MAX_CALLS * 2,
    maxContinuationBytes: PROGRAM_MAX_CONTINUATION_BYTES,
    maxHostFunctionArgumentsBytes: runEncodingLimit(PROGRAM_MAX_INPUT_BYTES),
    maxHostFunctionOutputBytes: runEncodingLimit(PROGRAM_MAX_OUTPUT_BYTES),
    maxInFlightBridgeRequests: PROGRAM_MAX_CALLS * 2,
    maxResultBytes: runEncodingLimit(PROGRAM_MAX_INPUT_BYTES + 2 * PROGRAM_MAX_CONSOLE_BYTES),
    maxSourceBytes: PROGRAM_MAX_SOURCE_BYTES + Buffer.byteLength(emptyWrapper),
    maxStackSizeBytes: PROGRAM_STACK_BYTES,
    memoryLimitBytes: PROGRAM_MEMORY_BYTES,
    timeoutMs: PROGRAM_TIMEOUT_MS,
  };

  const source = wrapProgram(input.code, hostNamespace, input.prelude);
  const start = () =>
    runner.run({
      abortSignal: input.abortSignal,
      continuation: input.resume?.continuation,
      continuationContext: { callId: input.callId },
      hostFunctions: { [hostNamespace]: hostFunctions },
      limits,
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
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (error.code === "RUN_CONCURRENCY_LIMIT" && delay !== undefined) {
        await delayWithAbort(delay, input.abortSignal);
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
    const value = parseJsonValue(settled.value ?? null);
    const valueBytes = Buffer.byteLength(JSON.stringify(value));
    if (valueBytes > PROGRAM_MAX_INPUT_BYTES) {
      return {
        error: `EXECUTE_VALUE_TOO_LARGE: the program's result is ${String(valueBytes)} bytes of JSON, over the ${String(PROGRAM_MAX_INPUT_BYTES)} byte limit.`,
        logs,
        status: "failed",
      };
    }
    return { logs, result: value, status: "completed" };
  }
  return { error: guestFailureMessage(settled.error), logs, status: "failed" };
}

function failed(error: string): ProgramSandboxOutcome {
  return { error, logs: [], status: "failed" };
}

function runFailureMessage(error: { readonly code: string; readonly message: string }): string {
  switch (error.code) {
    case "RUN_DETACHED_BRIDGE_REQUEST":
      return "The program returned while a call was still pending. Await every call before returning, including calls passed to Promise.race or Promise.any.";
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

function guestFailureMessage(error: unknown): string {
  if (!isObject(error)) return "The program failed.";
  const message = typeof error.message === "string" ? error.message : "The program failed.";
  const name = typeof error.name === "string" && error.name !== "" ? `${error.name}: ` : "";
  const frame =
    typeof error.stack === "string" ? /\(run\.js:(\d+):\d+\)/u.exec(error.stack)?.[1] : undefined;
  const line = frame === undefined ? 0 : Number(frame) - RUN_SOURCE_LINE_OFFSET;
  return `${name}${message}${line > 0 ? ` (line ${String(line)})` : ""}`;
}

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

async function delayWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

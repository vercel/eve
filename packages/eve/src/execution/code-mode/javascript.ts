import { performance } from "node:perf_hooks";
import { createHash, randomBytes } from "node:crypto";
import { jsonSchema, type ToolSet } from "ai";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonValue } from "#shared/json.js";
import { createWorkflowSandboxTool } from "#shared/workflow-sandbox.js";
import type {
  ProgramCall,
  ProgramCallResult,
  ProgramErrorClass,
  ProgramResume,
  ProgramRuntime,
  ProgramStart,
  ProgramStep,
} from "./runtime.js";

const LOG_BYTES = 16 * 1024;
interface BridgeCall extends ProgramCall {
  readonly logs: readonly string[];
  readonly limitExceeded?: boolean;
}
type State = {
  version: 2;
  runId: string;
  ticket: number;
  inputKey: string;
  calls: string[];
  pending: number[];
  logs: string[];
};
interface PendingCall {
  readonly call: ProgramCall;
  readonly resolve: (result: Resolution) => void;
}
type Resolution = { status: "completed"; output: JsonValue } | { status: "failed"; error: string };
type FinishedStep = Exclude<ProgramStep, { status: "parked" }>;
interface LiveExecution {
  readonly runId: string;
  readonly inputKey: string;
  readonly abort: AbortController;
  readonly pending: Map<number, PendingCall>;
  readonly calls: string[];
  readonly listeners: Set<() => void>;
  readonly timer: ReturnType<typeof setTimeout>;
  readyAt?: number;
  ticket: number;
  issued: number;
  logs: readonly string[];
  frontier?: readonly ProgramCall[];
  outcome?: FinishedStep;
}

/** Keep the vendor interpreter alive with unresolved host bridge promises. No tools run here. */
export class JavaScriptProgramRuntime implements ProgramRuntime {
  readonly language = "js" as const;
  private readonly executions = new Map<string, LiveExecution>();

  async start(input: ProgramStart): Promise<ProgramStep> {
    const started = performance.now();
    if (Date.now() >= input.limits.deadlineAt)
      return failure("Program deadline exceeded.", "deadline", []);
    return this.timedWait(this.launch(input, []), started);
  }

  async resume(input: ProgramResume): Promise<ProgramStep> {
    const started = performance.now();
    const state = input.state as State;
    const logs = Array.isArray(state?.logs) ? capLogs(state.logs) : [];
    if (Date.now() >= input.limits.deadlineAt) {
      if (state?.runId) this.stop(this.executions.get(state.runId));
      return failure("Program deadline exceeded.", "deadline", logs);
    }
    if (
      state?.version !== 2 ||
      typeof state.runId !== "string" ||
      !Number.isInteger(state.ticket) ||
      !Array.isArray(state.calls) ||
      !state.calls.every((call) => typeof call === "string") ||
      !Array.isArray(state.pending) ||
      !state.pending.every((index) => Number.isInteger(index) && index >= 0) ||
      state.inputKey !== inputKey(input)
    )
      return failure("Invalid JavaScript program state.", "runtime", logs);
    const recorded = new Map(input.results.map((result) => [result.index, result]));
    if (
      state.pending.some((index) => !recorded.has(index)) ||
      state.calls.some((_call, index) => !recorded.has(index))
    ) {
      this.stop(this.executions.get(state.runId));
      return failure("Missing recorded result for a program call.", "runtime", logs);
    }
    const existing = this.executions.get(state.runId);
    if (
      existing !== undefined &&
      existing.ticket === state.ticket &&
      existing.inputKey === state.inputKey
    ) {
      const pending = existing.frontier ?? [];
      const resolutions = pending.map((call) => {
        const result = recorded.get(call.index);
        if (result === undefined) throw new Error(`Missing result for program call ${call.index}.`);
        return { index: call.index, result: resolution(result) };
      });
      // Invalidate this checkpoint before resolving any guest promise.
      existing.ticket++;
      existing.frontier = undefined;
      for (const { index, result } of resolutions) {
        const call = existing.pending.get(index)!;
        existing.pending.delete(index);
        call.resolve(result);
      }
      return this.timedWait(existing, started, true);
    }
    // New process or stale checkpoint: replay interpreter work against recorded results.
    return this.timedWait(this.launch(input, input.results, logs, state.calls), started);
  }

  /** Release parked interpreters when their owning process or test is shutting down. */
  close(): void {
    for (const execution of this.executions.values()) this.stop(execution);
  }

  private launch(
    input: ProgramStart,
    recorded: readonly ProgramCallResult[],
    logs: readonly string[] = [],
    expectedCalls: readonly string[] = [],
  ): LiveExecution {
    const runId = randomBytes(24).toString("base64url");
    const abort = new AbortController();
    const execution: LiveExecution = {
      runId,
      inputKey: inputKey(input),
      abort,
      pending: new Map(),
      calls: [],
      listeners: new Set(),
      ticket: 0,
      issued: 0,
      logs,
      timer: setTimeout(
        () => {
          execution.outcome = failure("Program deadline exceeded.", "deadline", execution.logs);
          this.stop(execution);
          notify(execution);
        },
        Math.min(2147483647, Math.max(1, input.limits.deadlineAt - Date.now())),
      ),
    };
    execution.timer.unref();
    this.executions.set(runId, execution);
    const results = new Map(recorded.map((result) => [result.index, result]));
    const allowed = new Set(input.toolNames);
    const reject = (message: string, errorClass: ProgramErrorClass): Resolution => {
      execution.outcome = failure(message, errorClass, execution.logs);
      this.stop(execution);
      notify(execution);
      return { status: "failed", error: message };
    };
    const tools: ToolSet = {
      ready: {
        description: "Mark the interpreter ready before executing the guest program.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: () => {
          execution.readyAt ??= performance.now();
          return null;
        },
      },
      call: {
        description: "Suspend one allowlisted program tool call.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: (raw: unknown) => {
          const call = raw as BridgeCall;
          execution.logs = capLogs(call.logs ?? execution.logs);
          if (!allowed.has(call.tool))
            return reject(`Unknown program tool: ${call.tool}`, "unknown-tool");
          if (
            call.limitExceeded ||
            call.index !== execution.issued++ ||
            call.index >= input.limits.maxTotalCalls
          )
            return reject("Program call limit or issue-order violation.", "call-limit");
          const digest = createHash("sha256")
            .update(JSON.stringify([call.tool, call.input]))
            .digest("hex");
          if (expectedCalls[call.index] !== undefined && expectedCalls[call.index] !== digest)
            return reject("Recorded program call differs during interpreter replay.", "runtime");
          execution.calls.push(digest);
          const recordedResult = results.get(call.index);
          if (recordedResult !== undefined) return resolution(recordedResult);
          if (execution.pending.size >= input.limits.maxInFlightCalls)
            return reject("Program call limit exceeded.", "call-limit");
          return new Promise<Resolution>((resolve) => {
            execution.pending.set(call.index, {
              call: { index: call.index, input: call.input, tool: call.tool },
              resolve,
            });
          });
        },
      },
      park: {
        description: "Announce a side-effect-free interpreter checkpoint.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: (raw: unknown) => {
          execution.logs = capLogs((raw as { logs: string[] }).logs ?? execution.logs);
          if (execution.pending.size > 0 && execution.outcome === undefined) {
            execution.frontier = [...execution.pending.values()]
              .map(({ call }) => call)
              .sort((a, b) => a.index - b.index);
            execution.ticket++;
            notify(execution);
          }
          return null;
        },
      },
    };
    void (async () => {
      try {
        const tool = await createWorkflowSandboxTool({
          // One readiness bridge, then at most one checkpoint per issued call
          // and one limit-reporting call.
          bridgeRequestLimit: 2 * (input.limits.maxTotalCalls + 1) + 1,
          continuationSecurity: { signingKey: randomBytes(32).toString("base64url") },
          hostTools: tools,
          executionPolicy: {
            timeoutMs: Math.max(1, input.limits.deadlineAt - Date.now()),
            memoryLimitBytes: input.limits.memoryBytes,
            maxBridgeRequests: 2 * (input.limits.maxTotalCalls + 1) + 1,
            maxInFlightBridgeRequests: input.limits.maxInFlightCalls + 2,
            maxConsoleOutputBytes: LOG_BYTES,
          },
        });
        if (tool.execute === undefined) throw new Error("JavaScript sandbox has no executor.");
        const output = (await tool.execute(
          { js: wrapSource(input) } as never,
          { toolCallId: runId, abortSignal: abort.signal } as never,
        )) as FinishedStep;
        execution.outcome ??= { ...output, logs: capLogs(output.logs) };
      } catch (error) {
        const message = toErrorMessage(error);
        execution.outcome ??= failure(
          message,
          Date.now() >= input.limits.deadlineAt ? "deadline" : classify(message),
          execution.logs,
        );
      } finally {
        this.stop(execution);
        notify(execution);
      }
    })();
    return execution;
  }

  private async timedWait(
    execution: LiveExecution,
    started: number,
    warm = false,
  ): Promise<ProgramStep> {
    const outcome = await this.wait(execution);
    const ended = performance.now();
    // The ready bridge runs inside QuickJS: tool factory creation alone does not
    // include worker/context startup. Each resume measures only its active slice,
    // never the parked interval spent waiting for host tools or approval.
    const startupMs = warm ? 0 : Math.max(0, (execution.readyAt ?? ended) - started);
    return { ...outcome, timing: { startupMs, runMs: Math.max(0, ended - started - startupMs) } };
  }

  private async wait(execution: LiveExecution): Promise<ProgramStep> {
    while (execution.outcome === undefined && execution.frontier === undefined)
      await new Promise<void>((resolve) => execution.listeners.add(resolve));
    if (execution.outcome !== undefined) return execution.outcome;
    const state: State = {
      version: 2,
      runId: execution.runId,
      ticket: execution.ticket,
      inputKey: execution.inputKey,
      calls: [...execution.calls],
      pending: execution.frontier!.map((call) => call.index),
      logs: [...execution.logs],
    };
    return { status: "parked", calls: execution.frontier!, state: state as JsonValue };
  }

  private stop(execution: LiveExecution | undefined): void {
    if (execution === undefined) return;
    clearTimeout(execution.timer);
    this.executions.delete(execution.runId);
    execution.outcome ??= failure("Program execution closed.", "runtime", execution.logs);
    execution.abort.abort();
    notify(execution);
    for (const pending of execution.pending.values())
      pending.resolve({ status: "failed", error: "Program execution closed." });
    execution.pending.clear();
  }
}

function inputKey(input: ProgramStart): string {
  const { deadlineAt, memoryBytes, maxInFlightCalls, maxTotalCalls } = input.limits;
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.source,
        [...input.toolNames].sort(),
        deadlineAt,
        memoryBytes,
        maxInFlightCalls,
        maxTotalCalls,
      ]),
    )
    .digest("hex");
}
function resolution(result: ProgramCallResult): Resolution {
  return result.status === "completed"
    ? { status: "completed", output: result.output }
    : {
        status: "failed",
        error:
          result.status === "unknown"
            ? `Outcome unknown: the side effect may or may not have happened. ${result.error}`
            : result.error,
      };
}
function notify(execution: LiveExecution): void {
  for (const resolve of execution.listeners) resolve();
  execution.listeners.clear();
}
function wrapSource(input: ProgramStart): string {
  // All mutable bookkeeping is lexical, outside the model-written function.
  // The bridge receives issue indices from the sandbox, not host completion order.
  return `await tools.ready({}); return await (async (__host) => {
    let __issued = 0, __inFlight = 0, __logSize = 0, __checkpointScheduled = false;
    const __checkpoint = () => {
      if (__checkpointScheduled) return;
      __checkpointScheduled = true;
      Promise.resolve().then(() => {
        __checkpointScheduled = false;
        return __host.park({ logs: __logs });
      }).catch(() => {});
    };
    const __logs = [];
    const __console = Object.freeze(Object.fromEntries(["log", "info", "warn", "error", "debug"].map(name => [name, (...args) => {
      const text = args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
      const remaining = ${LOG_BYTES} - __logSize;
      if (remaining > 0 && __logs.length < 256) { const line = text.slice(0, Math.floor(remaining / 4)); __logs.push(line); __logSize += line.length * 4; }
    }])));
    const __allowed = Object.create(null);
    for (const name of ${JSON.stringify(input.toolNames)}) {
      __allowed[name] = async (input = null) => {
        const index = __issued++;
        __checkpoint();
        if (index >= ${input.limits.maxTotalCalls} || __inFlight >= ${input.limits.maxInFlightCalls}) {
          await __host.call({ index, tool: name, input: null, logs: __logs, limitExceeded: true });
          throw new Error("Program call limit exceeded.");
        }
        __inFlight++;
        try {
          const result = await __host.call({ index, tool: name, input, logs: __logs });
          if (result.status !== "completed") throw new Error(result.error);
          return result.output;
        }
        finally { __inFlight--; }
      };
    }
    Object.freeze(__allowed);
    const __tools = new Proxy(__allowed, { get(target, name) {
      if (typeof name === "string" && !Object.hasOwn(target, name)) throw new Error("Unknown program tool: " + name);
      return target[name];
    } });
    try {
      const output = await (async (tools, console) => {\n${input.source}\n})(__tools, __console);
      return { status: "completed", output: output ?? null, logs: __logs };
    } catch (error) {
      const message = String(error && error.message || error);
      const errorClass = message.includes("call limit") ? "call-limit" : message.includes("Unknown program tool") ? "unknown-tool" : "runtime";
      return { status: "failed", error: message, errorClass, logs: __logs };
    }
  })(tools);`;
}

function classify(message: string): ProgramErrorClass {
  if (/timeout|timed out|deadline|interrupted/i.test(message)) return "deadline";
  if (/memory|allocation/i.test(message)) return "memory";
  if (/limit|bridge requests/i.test(message)) return "call-limit";
  if (/syntax/i.test(message)) return "syntax";
  if (/unknown.*tool/i.test(message)) return "unknown-tool";
  return "runtime";
}

function failure(
  error: string,
  errorClass: ProgramErrorClass,
  logs: readonly string[],
): FinishedStep {
  return {
    status: "failed",
    error,
    errorClass,
    logs: capLogs(logs),
    timing: { startupMs: 0, runMs: 0 },
  };
}

/** Enforce the output cap outside generated code as well as inside it. */
function capLogs(logs: readonly string[]): string[] {
  const bounded: string[] = [];
  let remaining = LOG_BYTES;
  for (const log of logs.slice(0, 256)) {
    const bytes = Buffer.from(String(log));
    const line = bytes.subarray(0, remaining).toString("utf8");
    // Truncating a multibyte sequence can add a replacement character.
    const safe = Buffer.byteLength(line) <= remaining ? line : line.slice(0, -1);
    bounded.push(safe);
    remaining -= Buffer.byteLength(safe);
    if (remaining <= 0) break;
  }
  return bounded;
}

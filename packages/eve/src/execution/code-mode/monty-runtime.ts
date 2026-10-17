import { performance } from "node:perf_hooks";
import { collectPythonLogs } from "./python-logs.js";
import { randomUUID } from "node:crypto";
import type { Monty, MontySession, Snapshot } from "@pydantic/monty/wasm";
import type { JsonValue } from "#shared/json.js";
import type {
  ProgramRuntime,
  ProgramStart,
  ProgramResume,
  ProgramStep,
  ProgramCall,
  ProgramCallResult,
  ProgramErrorClass,
} from "./runtime.js";

/** Python uses flat external names: `await namespace__tool({"key": "value"})`.
 * Only recorded calls are durable. Live continuations are a process-local optimization;
 * an absent continuation replays recorded calls in a fresh sandbox.
 */
interface LiveExecution {
  session: MontySession;
  snapshot: Snapshot;
  index: number;
  logs: string[];
  pendingIds: Map<number, number>;
  identity: string;
  timer: ReturnType<typeof setTimeout>;
  resultsIdentity: string;
}
export class MontyProgramRuntime implements ProgramRuntime {
  private pool: Promise<Monty> | undefined;
  private readyWorkers = new Set<number | undefined>();
  private live = new Map<string, LiveExecution>();
  async close(): Promise<void> {
    for (const execution of this.live.values()) {
      clearTimeout(execution.timer);
      await execution.session.close();
    }
    this.live.clear();
    if (this.pool) await (await this.pool).close();
    this.pool = undefined;
    this.readyWorkers.clear();
  }
  readonly language = "py" as const;
  start(input: ProgramStart): Promise<ProgramStep> {
    return this.run(input, []);
  }
  resume(input: ProgramResume): Promise<ProgramStep> {
    return this.run(
      input,
      input.results,
      typeof input.state === "string" ? input.state : undefined,
    );
  }

  private async run(
    input: ProgramStart,
    results: readonly ProgramCallResult[],
    token?: string,
  ): Promise<ProgramStep> {
    const timing = { startupMs: 0, runMs: 0 };
    try {
      const step = await this.runMeasured(input, results, token, timing);
      return { ...step, timing };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        errorClass: "runtime",
        error: message.includes("@pydantic/monty")
          ? "Python code mode requires the optional @pydantic/monty dependency. Install it in your app."
          : message,
        logs: [],
        timing,
      };
    }
  }

  private async runMeasured(
    input: ProgramStart,
    results: readonly ProgramCallResult[],
    token: string | undefined,
    timing: { startupMs: number; runMs: number },
  ): Promise<ProgramStep> {
    async function drive(operation: () => Promise<Snapshot>): Promise<Snapshot> {
      const started = performance.now();
      try {
        return await operation();
      } finally {
        timing.runMs += performance.now() - started;
      }
    }
    const startupStarted = performance.now();
    const { Monty, MontyComplete, NameLookupSnapshot, FunctionSnapshot, FutureSnapshot } =
      await import("@pydantic/monty/wasm");
    const resultsIdentity = JSON.stringify(results);
    const identity = JSON.stringify([input.source, input.toolNames, input.limits]);
    let execution = token ? this.live.get(token) : undefined;
    const resultIndexes = new Set(results.map((result) => result.index));
    if (
      execution?.identity !== identity ||
      (execution &&
        [...execution.pendingIds.values()].some((index) => !resultIndexes.has(index))) ||
      (execution &&
        execution.resultsIdentity !==
          JSON.stringify(
            results.filter((result) => result.index < Math.min(...execution!.pendingIds.values())),
          ))
    )
      execution = undefined;
    if (execution && token) this.live.delete(token);
    const logs: string[] = execution?.logs ?? [];
    const pending: ProgramCall[] = [];
    const futures = new Map<number, ProgramCallResult>();
    let errorClass: ProgramErrorClass = "runtime";
    const remaining = (input.limits.deadlineAt - Date.now()) / 1000;
    if (remaining <= 0)
      return { status: "failed", error: "Program deadline exceeded", errorClass: "deadline", logs };
    this.pool ??= Monty.create({ maxProcesses: 32 });
    const pool = await this.pool;
    let parked = false;
    let session: MontySession | undefined = execution?.session;
    try {
      session ??= await pool.checkout({
        limits: {
          maxMemory: input.limits.memoryBytes,
          maxRecursionDepth: 1000,
          maxFeedDurationSecs: remaining,
          maxTurnDurationSecs: remaining,
        },
        osPolicy: {
          datetime: "call_host",
          randomStart: "call_host",
          sleep: "call_host",
          processTime: "zero",
        },
      });
      if (!execution && !this.readyWorkers.has(session.workerId))
        timing.startupMs = performance.now() - startupStarted;
      this.readyWorkers.add(session.workerId);
      const recorded = new Map(results.map((result) => [result.index, result]));
      let index = execution?.index ?? 0;
      const pendingIds = execution?.pendingIds ?? new Map<number, number>();
      for (const [callId, callIndex] of pendingIds) {
        const result = recorded.get(callIndex);
        if (result) futures.set(callId, result);
      }
      let snapshot: Snapshot =
        execution?.snapshot ??
        (await drive(() =>
          session!.feedStart(input.source, {
            printCallback: (_stream, text) => collectPythonLogs(logs, text),
          }),
        ));
      while (!(snapshot instanceof MontyComplete)) {
        if (Date.now() >= input.limits.deadlineAt) {
          errorClass = "deadline";
          throw new Error("Program deadline exceeded");
        }
        if (snapshot instanceof NameLookupSnapshot) {
          const lookup = snapshot;
          snapshot = await drive(() =>
            lookup.resume(
              input.toolNames.includes(lookup.variableName) ? lookup.variableName : undefined,
            ),
          );
        } else if (snapshot instanceof FunctionSnapshot) {
          if (snapshot.isOsFunction) {
            const call = snapshot;
            snapshot = await drive(() =>
              call.resumeError(new Error("Clock, entropy and OS access are disabled")),
            );
            continue;
          }
          if (!input.toolNames.includes(snapshot.functionName)) {
            errorClass = "unknown-tool";
            throw new Error(`Unknown tool: ${snapshot.functionName}`);
          }
          if (index >= Math.min(256, input.limits.maxTotalCalls)) {
            errorClass = "call-limit";
            throw new Error("Total tool call limit exceeded");
          }
          const call: ProgramCall = {
            index: index++,
            tool: snapshot.functionName,
            input: json(snapshot.args.length === 0 ? snapshot.kwargs : snapshot.args[0]),
          };
          if (
            snapshot.args.length > 1 ||
            (snapshot.args.length > 0 && Object.keys(snapshot.kwargs).length > 0)
          )
            throw new Error("Tools accept one input object");
          const result = recorded.get(call.index);
          if (result) {
            futures.set(snapshot.callId, result);
            const callSnapshot = snapshot;
            snapshot = await drive(() => callSnapshot.resumeFuture());
          } else {
            if (pending.length >= Math.min(32, input.limits.maxInFlightCalls)) {
              errorClass = "call-limit";
              throw new Error("In-flight tool call limit exceeded");
            }
            pending.push(call);
            pendingIds.set(snapshot.callId, call.index);
            const callSnapshot = snapshot;
            snapshot = await drive(() => callSnapshot.resumeFuture());
          }
        } else if (snapshot instanceof FutureSnapshot) {
          if (futures.size > 0) {
            const ready = [...futures].filter(
              ([id]) => snapshot instanceof FutureSnapshot && snapshot.pendingCallIds.includes(id),
            );
            if (ready.length > 0) {
              const futureSnapshot = snapshot;
              snapshot = await drive(() =>
                futureSnapshot.resume(
                  ready.map(([callId, result]) =>
                    result.status === "completed"
                      ? { callId, value: result.output }
                      : {
                          callId,
                          error: new Error(
                            result.status === "unknown"
                              ? `Side effect may or may not have happened: ${result.error}`
                              : result.error,
                          ),
                        },
                  ),
                ),
              );
              for (const [id] of ready) {
                futures.delete(id);
                pendingIds.delete(id);
              }
              continue;
            }
          }
          const key = randomUUID();
          if (execution) clearTimeout(execution.timer);
          const timer = setTimeout(
            () => {
              const expired = this.live.get(key);
              this.live.delete(key);
              void expired?.session.close();
            },
            Math.max(1, input.limits.deadlineAt - Date.now()),
          );
          timer.unref();
          this.live.set(key, {
            session,
            snapshot,
            index,
            logs,
            pendingIds,
            identity,
            timer,
            resultsIdentity,
          });
          parked = true;
          return { status: "parked", calls: pending, state: key };
        }
      }
      // A synchronous external may return an unawaited future. Its call still needs dispatch.
      if (pending.length > 0) return { status: "parked", calls: pending, state: null };
      return { status: "completed", output: json(snapshot.output), logs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/SyntaxError/u.test(message)) errorClass = "syntax";
      else if (/MemoryError|memory limit/iu.test(message)) errorClass = "memory";
      else if (/TimeoutError|timed out/iu.test(message)) errorClass = "deadline";
      return { status: "failed", error: message, errorClass, logs };
    } finally {
      if (!parked) {
        if (execution) clearTimeout(execution.timer);
        await session?.close();
      }
    }
  }
}

function json(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Map)
    return Object.fromEntries(
      [...value].map(([key, entry]) => {
        if (typeof key !== "string") throw new Error("JSON object keys must be strings");
        return [key, json(entry)];
      }),
    );
  if (Array.isArray(value)) return value.map(json);
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, json(entry)]));
  throw new Error("Program values must be JSON");
}

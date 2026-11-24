import { builtInHosts, type App } from "#runtime/app.js";
import { createLifetime } from "#runtime/lifetime.js";
import { testEntities } from "#internal/testing/test-platform.js";
import type { Runtime } from "#channel/types.js";
import { hookAddress, type Durable } from "#execution/durable.js";
import { registerHost, registerSessionEventStore, resumeRoutedHook } from "#execution/hosts.js";
import { IN_PROCESS_DEPLOYMENT_ID, createInProcessHost } from "#execution/in-process/host.js";
import type { InProcessHostOptions } from "#execution/in-process/host.js";
import type { WorkflowFunction } from "#execution/in-process/runs.js";
import { createStepAttempts } from "#execution/in-process/step-attempts.js";
import {
  acrossStepBoundary,
  structuredCloneBoundary,
} from "#execution/in-process/step-boundary.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import type { SessionEventStore } from "#execution/session-event-store.js";
import { sessionRuntime } from "#execution/session-runtime.js";
import type { SessionStepCall } from "#execution/session/steps.js";
import type { TurnStepInput } from "#execution/session/turn-step-types.js";
import {
  sessionSteps,
  storeDurable,
  type SessionStreamSink,
  type StoreDurable,
} from "#platform/engine.js";

import { createMemorySessionStore, type MemorySessionStore } from "./memory-session-store.js";

export interface StoreEngineOptions extends Partial<InProcessHostOptions> {
  readonly deadlineMs?: number;
  readonly outOfLine?: boolean;
}

export interface StoreEngine {
  readonly runtime: Runtime;
  readonly durable: Durable;
  readonly store: MemorySessionStore;
  crashOnRecord(crashes: (count: number) => boolean): void;
  records(): number;
  largestStepResult(): number;
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  restart(): Promise<void>;
  idle(): Promise<void>;
  dispose(): Promise<void>;
}

interface Run {
  dead: boolean;
  finished?: Promise<void>;
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const NO_CHUNK = new Uint8Array();

export function createStoreEngine(
  config: SessionRuntimeConfig,
  options: StoreEngineOptions = {},
): StoreEngine {
  const hosts = builtInHosts();
  const platform = options.platform ?? testEntities();
  const store = createMemorySessionStore();
  const boundary = options.stepBoundary ?? structuredCloneBoundary;
  const kept = new Map<string, { readonly value: unknown }>();
  const tries = new Map<string, number>();
  const runs = new Map<string, Run>();
  const pending = new Set<string>();
  const known = new Set<string>();
  const releases: (() => void)[] = [];
  const runtimes = new Map<string, Runtime>();
  const attempts = createStepAttempts(options.stepFaults);
  const encoder = new TextEncoder();
  let crashes: ((count: number) => boolean) | undefined;
  let recordCount = 0;
  let closed = false;

  const runtimeFor = (child: SessionRuntimeConfig): Runtime => {
    const key = JSON.stringify(child);
    let runtime = runtimes.get(key);
    if (runtime === undefined)
      runtimes.set(key, (runtime = sessionRuntime(engine.durable, hosts, child)));
    return runtime;
  };
  const inProcess = createInProcessHost(
    { ...options, platform, stepFaults: undefined },
    runtimeFor,
  );
  const app: App = {
    platform,
    hosts,
    get durable(): Durable {
      return engine.durable;
    },
    lifetime: createLifetime(),
  };

  const lines: SessionEventStore = {
    async assertReadable(sessionId) {
      if ((await store.status(sessionId)) === undefined)
        throw new Error(`Session "${sessionId}" isn't in the store.`);
    },
    tail: (sessionId) => store.streams.tail(sessionId),
    readable(sessionId, startIndex = 0) {
      const iterator = store.streams.read(sessionId, startIndex)[Symbol.asyncIterator]();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(`${next.value.line}\n`));
        },
        cancel() {
          void iterator.return?.();
        },
      });
    },
  };

  const die = (sessionId: string, run: Run): void => {
    run.dead = true;
    if (runs.get(sessionId) === run) runs.delete(sessionId);
  };

  const faultySink = (attempt: Parameters<typeof attempts.writable>[0]): SessionStreamSink => ({
    async append(sessionId, from, appended) {
      if (options.stepFaults?.failWrite?.(attempt, NO_CHUNK) === true)
        throw new Error("The session stream is unavailable");
      await store.streams.append(sessionId, from, appended);
    },
    close: (sessionId) => store.streams.close(sessionId),
  });

  const content = options.outOfLine === false ? {} : { content: store.content };

  const runTurn = async (input: TurnStepInput, key: string, sessionId: string) =>
    await attempts.run(
      { name: "turnStep", sessionId },
      async (attempt) => ({ attempt, data: await acrossStepBoundary(boundary, input) }),
      async ({ attempt, data }) => {
        const steps = sessionSteps(app, {
          interrupts: engine.interrupts,
          streams: faultySink(attempt),
          ...content,
        });
        while (true) {
          const tried = (tries.get(key) ?? 0) + 1;
          tries.set(key, tried);
          const result = await steps.run("turn", data, {
            attempt: tried,
            key,
            sessionId,
            ...(options.deadlineMs !== undefined && { deadline: Date.now() + options.deadlineMs }),
          });
          if (!("yielded" in result)) return result;
        }
      },
    );

  const loader = sessionSteps(app, { streams: store.streams, ...content });

  const keptSteps = (run: Run): SessionStepCall => {
    const steps = sessionSteps(app, {
      interrupts: engine.interrupts,
      streams: store.streams,
      ...content,
    });
    return async (name, input, key, stepRun) => {
      if (run.dead) return await never();
      const sessionId = key.slice(0, key.indexOf(":"));
      let held = kept.get(key);
      if (held === undefined) {
        const value =
          name === "dispatchRuns" || name === "applyRunMessages"
            ? await inProcess.step(name, input, key, stepRun)
            : name === "turn"
              ? await runTurn(input as TurnStepInput, key, sessionId)
              : await steps.run(name, input, {
                  attempt: 1,
                  key,
                  sessionId,
                });
        if (run.dead) return await never();
        held = { value: await acrossStepBoundary(boundary, value) };
        kept.set(key, held);
      }
      return (await loader.load(held.value as never, sessionId)) as never;
    };
  };

  const wake = async (sessionId: string): Promise<void> => {
    if (!known.has(sessionId)) {
      known.add(sessionId);
      releases.push(registerSessionEventStore(hosts, sessionId, lines));
    }
    if (closed) return;
    if (runs.has(sessionId)) {
      pending.add(sessionId);
      return;
    }
    const run: Run = { dead: false };
    runs.set(sessionId, run);
    run.finished = engine
      .run(sessionId, {
        deploymentId: IN_PROCESS_DEPLOYMENT_ID,
        step: keptSteps(run),
        toolStubs: inProcess.toolStubs,
      })
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (run.dead) return;
        die(sessionId, run);
        if (pending.delete(sessionId)) void wake(sessionId);
      });
  };

  const engine: StoreDurable = storeDurable({ store, wake });

  store.saveRecordHook = (sessionId) => {
    recordCount += 1;
    if (crashes?.(recordCount) !== true) return undefined;
    const run = runs.get(sessionId);
    if (run !== undefined) die(sessionId, run);
    queueMicrotask(() => void wake(sessionId));
    return never();
  };

  releases.push(
    registerHost(hosts, {
      async deliver(token, payload) {
        const to = hookAddress(token);
        if ((await engine.durable.sessionFor(to)) === undefined) return undefined;
        const delivered = await engine.durable.deliver(to, payload);
        return delivered.accepted ? "delivered" : undefined;
      },
      runEnded: () => undefined,
      cancelRun: () => undefined,
      signInCallbacks: (sessionId) =>
        options.callbackBaseUrl === undefined || !known.has(sessionId)
          ? undefined
          : {
              callbackBaseUrl: options.callbackBaseUrl.replace(/\/$/, ""),
              deliver: async (to, payload) => {
                await resumeRoutedHook(hosts, to.key.slice(to.key.indexOf(":") + 1), payload);
              },
            },
    }),
  );

  return {
    runtime: runtimeFor(config),
    get durable() {
      return engine.durable;
    },
    store,
    crashOnRecord(predicate) {
      crashes = predicate;
    },
    records: () => recordCount,
    largestStepResult: () =>
      Math.max(
        0,
        ...[...kept.values()].map(
          ({ value }) => encoder.encode(JSON.stringify(value) ?? "").byteLength,
        ),
      ),
    registerWorkflow: (workflowId, body) => inProcess.runs.registerWorkflow(workflowId, body),
    async restart() {
      for (const [sessionId, run] of runs) die(sessionId, run);
      pending.clear();
      for (const sessionId of known)
        if ((await store.status(sessionId)) === "running") await wake(sessionId);
    },
    async idle() {
      for (let quiet = 0; quiet < 3;) {
        await inProcess.idle();
        if (runs.size > 0) {
          await Promise.race([
            ...[...runs.values()].map(async (run) => await run.finished),
            new Promise((resolve) => setTimeout(resolve, 10)),
          ]);
          quiet = 0;
          continue;
        }
        await nextMacrotask();
        quiet += 1;
      }
    },
    async dispose() {
      closed = true;
      for (const [sessionId, run] of runs) die(sessionId, run);
      await inProcess.dispose();
      for (const release of releases.splice(0)) release();
    },
  };
}

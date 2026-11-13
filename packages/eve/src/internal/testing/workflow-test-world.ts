import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createWorld } from "@workflow/world-local";

import { workflowDriverCodePath } from "#internal/workflow-bundle/builder-support.js";
import { setWorld, workflowEntrypoint } from "#internal/workflow/runtime.js";

// The local World an integration test file's sessions run on, opened by the Workflow test setup
// (`test/setup/workflow-setup.ts`). It tells a test when nothing in it is working, from the queue
// itself: a message is working while it is delivered or due, and resting while it waits out a
// timer (a sleep or a hook's `timeoutSeconds`). It can also restart, as a process that dies and
// starts again on the same data directory does, and redeliver a delivery a test failed on purpose
// at once, instead of after the queue's 5s backoff.

type LocalWorld = ReturnType<typeof createWorld>;
type Handler = (request: Request) => Promise<Response>;

export interface TestWorldOptions {
  readonly dataDir: string;
  readonly tag: string;
  /** The queue prefix the test bundle's flow route serves. */
  readonly prefix: string;
  /** The test bundle's directory, whose flow route is loaded on the first delivery. */
  readonly outDir: string;
  /** The queue namespace the test bundle's flow route serves. */
  readonly namespace: string;
}

export interface TestWorld {
  /** The World running now. */
  readonly world: LocalWorld;
  /** Resolves once no queue message is being delivered or due, as a macrotask sees it. */
  idle(): Promise<void>;
  /**
   * Redelivers the next delivery whose handler fails at once, as the queue would after its
   * backoff: for a fault a test injects, whose retry needn't wait.
   */
  redeliverNextFailure(): void;
  /**
   * Drops this process's World, as a crash does, and opens a new one on the same data directory as
   * `eve start` boots one (`installWorkflowWorld`): guarded against replaying stranded runs, it
   * recovers its active runs. Deliveries still running are abandoned. `beforeStart` runs while no World is open. Resolves with the runs the
   * new World recovers.
   */
  restart(options?: { readonly beforeStart?: () => Promise<void> }): Promise<string[]>;
  /** The runs that haven't ended. */
  activeRunIds(): Promise<string[]>;
  /** The waits the World stored, as `<dataDir>/waits` holds them. */
  storedWaits(): Promise<StoredWait[]>;
  /**
   * Fails the next `wait_created` of a wait due within `dueWithinMs` once its wait is stored and
   * before its event is, as a process that dies between the two leaves the World. Resolves once
   * it did.
   */
  crashBeforeNextWaitEvent(dueWithinMs: number): Promise<void>;
  /** Rewrites a stored run's attributes; call it from `restart`'s `beforeStart`. */
  rewriteRunAttributes(runId: string, patch: Record<string, string | undefined>): Promise<void>;
  /** Refuses new deliveries, waits for running ones, and closes the World. */
  close(): Promise<void>;
}

export interface StoredWait {
  readonly waitId: string;
  readonly runId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly resumeAt?: string;
  readonly completedAt?: string;
}

const CURRENT = Symbol.for("eve.testing.workflow-test-world");

/** The test file's World, once the Workflow test setup opened it. */
export function currentTestWorld(): TestWorld {
  const world = (globalThis as { [CURRENT]?: TestWorld })[CURRENT];
  if (world === undefined) throw new Error("No Workflow test World is open in this file.");
  return world;
}

/** Opens the test file's World and makes it the runtime's. */
export async function openTestWorld(options: TestWorldOptions): Promise<TestWorld> {
  const deliveries = trackDeliveries(lazyHandler(options));
  let world = await startWorld(options, deliveries, { recover: false });
  await world.clear();

  const runFile = async (runId: string) => {
    const runs = join(options.dataDir, "runs");
    const name = (await readdir(runs)).find((file) => file.startsWith(`${runId}.`));
    if (name === undefined) throw new Error(`The World stored no run "${runId}".`);
    return join(runs, name);
  };

  const testWorld: TestWorld = {
    get world() {
      return world;
    },
    idle: () => deliveries.idle(),
    redeliverNextFailure: () => deliveries.redeliverNextFailure(),
    async restart({ beforeStart } = {}) {
      const recovering = await activeRunIds(world);
      deliveries.abandon();
      await world.close?.();
      setWorld(undefined);
      newRealm();
      await beforeStart?.();
      // A new process loads the flow route again, which reads the World it boots with.
      deliveries.reopen(recovering, lazyHandler(options));
      world = await startWorld(options, deliveries, { recover: true });
      return recovering;
    },
    activeRunIds: () => activeRunIds(world),
    async storedWaits() {
      const directory = join(options.dataDir, "waits");
      const files = await readdir(directory).catch(() => []);
      return await Promise.all(
        files
          .filter((file) => file.endsWith(`.${options.tag}.json`))
          .map(
            async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as StoredWait,
          ),
      );
    },
    crashBeforeNextWaitEvent(dueWithinMs) {
      return new Promise<void>((resolve) => {
        const create = world.events.create.bind(world.events);
        const crashing = world;
        crashing.events.create = (async (...args: Parameters<typeof create>) => {
          const [runId, event] = args;
          if (
            event.eventType !== "wait_created" ||
            new Date(event.eventData.resumeAt).getTime() - Date.now() > dueWithinMs
          )
            return await create(...args);
          crashing.events.create = create;
          // What world-local writes before the event (`events-storage.ts`): the wait's claim, then
          // the wait.
          const waitId = `${runId}-${event.correlationId}`;
          const locks = join(options.dataDir, ".locks", "waits");
          await mkdir(locks, { recursive: true });
          await writeFile(join(locks, `${waitId}.created.${options.tag}`), "", { flag: "wx" });
          const now = new Date();
          await writeFile(
            join(options.dataDir, "waits", `${waitId}.${options.tag}.json`),
            JSON.stringify({
              createdAt: now,
              resumeAt: event.eventData.resumeAt,
              runId,
              specVersion: event.specVersion,
              status: "waiting",
              updatedAt: now,
              waitId,
            }),
          );
          resolve();
          throw new Error("The process exited before the wait's event was written.");
        }) as typeof create;
      });
    },
    async rewriteRunAttributes(runId, patch) {
      const path = await runFile(runId);
      const run = JSON.parse(await readFile(path, "utf8")) as {
        attributes?: Record<string, string>;
      };
      const attributes = { ...run.attributes };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete attributes[key];
        else attributes[key] = value;
      }
      await writeFile(path, JSON.stringify({ ...run, attributes }));
    },
    async close() {
      await deliveries.close();
      await world.close?.();
      setWorld(undefined);
      delete (globalThis as { [CURRENT]?: TestWorld })[CURRENT];
    },
  };
  (globalThis as { [CURRENT]?: TestWorld })[CURRENT] = testWorld;
  return testWorld;
}

async function startWorld(
  options: TestWorldOptions,
  deliveries: Deliveries,
  { recover }: { readonly recover: boolean },
): Promise<LocalWorld> {
  const created = createWorld({
    dataDir: options.dataDir,
    // A file starts on a cleared World, so only a restart recovers runs.
    recoverActiveRuns: recover,
    tag: options.tag,
  });
  // A file's own runs are never stranded; a restart boots as an app does. Loaded only then, so
  // every other file's setup doesn't import it.
  const world = recover
    ? (
        await import("#execution/session-inbox/stranded-replay-guard.js")
      ).guardStrandedSessionReplay(created)
    : created;
  world.registerHandler(options.prefix as never, deliveries.handler);
  const queue = world.queue.bind(world);
  world.queue = async (name, message, opts) => {
    const queued = await queue(name, message, opts);
    if (queued.messageId !== null)
      deliveries.queued(queued.messageId, (opts?.delaySeconds ?? 0) > 0);
    return queued;
  };
  setWorld(world);
  await world.start?.();
  return world;
}

/** The runs a restart recovers: the World re-enqueues each, and the test waits for them. */
async function activeRunIds(world: LocalWorld): Promise<string[]> {
  const ids: string[] = [];
  for (const status of ["pending", "running"] as const) {
    let cursor: string | undefined;
    do {
      const page = await world.runs.list({
        pagination: { cursor, limit: 100 },
        resolveData: "none",
        status,
      });
      ids.push(...page.data.map((run) => run.runId));
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
  return ids;
}

/**
 * Makes this realm look newly started to Workflow, as the process a restart stands in for is: a
 * step started before it boots is the dead process's to release (world-local's `realmBoot`), and
 * none of its steps is still in flight here (core's step single-flight).
 */
function newRealm(): void {
  const store = globalThis as Record<symbol, unknown>;
  const boot = store[Symbol.for("@workflow/world-local//realmBoot/v1")] as
    | { bootedAt: number }
    | undefined;
  if (boot !== undefined) boot.bootedAt = Date.now();
  const singleFlight = store[Symbol.for("@workflow/core//stepSingleFlight/v1")] as
    | { inFlight: Map<string, unknown> }
    | undefined;
  singleFlight?.inFlight.clear();
}

interface Deliveries {
  readonly handler: Handler;
  /** A message the queue accepted: due now, or later when it's `delayed`. */
  queued(messageId: string, delayed: boolean): void;
  idle(): Promise<void>;
  redeliverNextFailure(): void;
  /** Forgets running deliveries, as a crash does; their handlers' results are ignored. */
  abandon(): void;
  /**
   * Accepts deliveries again, into `handle`, counting the runs a recovering World re-enqueues as
   * due.
   */
  reopen(recovering: readonly string[], handle: Handler): void;
  close(): Promise<void>;
}

/**
 * Counts what the queue is working on. A message is due from when it's queued (unless delayed)
 * until its handler is called; it is being delivered while the handler runs; and once the handler
 * answers, it is due again (a failure, or a handoff), resting (a timer), or done.
 */
function trackDeliveries(initial: Handler): Deliveries {
  let handle = initial;
  const due = new Map<string, number>();
  const seen = new Set<string>();
  const recovering = new Set<string>();
  let running = 0;
  let generation = 0;
  let closing = false;
  let redeliver = 0;
  const waiters = new Set<() => void>();

  const busy = () => running > 0 || recovering.size > 0 || [...due.values()].some((n) => n > 0);
  const wake = () => {
    if (busy()) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const adjust = (messageId: string, by: number) => {
    const next = (due.get(messageId) ?? 0) + by;
    if (next === 0) due.delete(messageId);
    else due.set(messageId, next);
  };

  /** What the queue does next with a message whose handler answered `response`. */
  const afterResponse = async (messageId: string, response: Response) => {
    if (!response.ok) {
      adjust(messageId, 1);
      return;
    }
    // `timeoutSeconds: 0` redelivers at once; more waits out a timer.
    const text = await response.clone().text();
    if (!text.includes("timeoutSeconds")) return;
    const timeoutSeconds = Number(
      (JSON.parse(text) as { timeoutSeconds?: unknown }).timeoutSeconds,
    );
    if (timeoutSeconds === 0) adjust(messageId, 1);
  };

  const handler: Handler = async (request) => {
    // world-local drops a delivery whose handler throws an AbortError.
    if (closing) throw new DOMException("The test workflow world is closing.", "AbortError");
    const messageId = request.headers.get("x-vqs-message-id") ?? "";
    const ours = generation;
    seen.add(messageId);
    adjust(messageId, -1);
    running += 1;
    try {
      // Only a restart's recovery, or a delivery a test may fail on purpose, reads the body.
      if (recovering.size === 0 && redeliver === 0) {
        const response = await handle(request);
        if (ours === generation) await afterResponse(messageId, response);
        return response;
      }
      const body = await request.text();
      const runId = runIdOf(body);
      if (runId !== undefined) recovering.delete(runId);
      let attempt = Number(request.headers.get("x-vqs-message-attempt") ?? "1");
      for (;;) {
        const headers = new Headers(request.headers);
        headers.set("x-vqs-message-attempt", String(attempt));
        const response = await handle(new Request(request.url, { body, headers, method: "POST" }));
        if (ours !== generation) return response;
        if (!response.ok && redeliver > 0) {
          redeliver -= 1;
          attempt += 1;
          continue;
        }
        await afterResponse(messageId, response);
        return response;
      }
    } finally {
      if (ours === generation) {
        running -= 1;
        // Let the queue act on the answer (redeliver, or arm a timer) before reading rest.
        setImmediate(wake);
      }
    }
  };

  return {
    handler,
    queued(messageId, delayed) {
      // An idempotent enqueue names a message already counted.
      if (delayed || seen.has(messageId)) return;
      seen.add(messageId);
      adjust(messageId, 1);
    },
    async idle() {
      // Rest must hold across a macrotask: what a handler's answer starts is queued by then.
      for (;;) {
        if (busy()) await new Promise<void>((resolve) => waiters.add(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        if (!busy()) return;
      }
    },
    redeliverNextFailure() {
      redeliver += 1;
    },
    abandon() {
      generation += 1;
      running = 0;
      due.clear();
      redeliver = 0;
    },
    reopen(runs, next) {
      handle = next;
      for (const runId of runs) recovering.add(runId);
    },
    async close() {
      closing = true;
      // Stay within Vitest's 10s hook timeout if a delivery never settles.
      const deadline = Date.now() + 5_000;
      while (running > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

function runIdOf(body: string): string | undefined {
  try {
    const runId = (JSON.parse(body) as { runId?: unknown }).runId;
    return typeof runId === "string" ? runId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bundle's flow route, built on its first delivery; each call builds its own, as each process
 * that boots loads its own.
 *
 * The step registrations bundle is tens of megabytes, and Vite transforms it per worker at a cost
 * of seconds, so the config externalizes it and Node loads it natively instead. Steps reach the
 * driver through globals, so the two can load in different module graphs.
 *
 * The entrypoint itself is built here rather than imported from the generated `workflows.mjs`:
 * that file imports the Workflow runtime by path, which Node would load a second time, and with
 * it a World no test installs. Calling the runtime this file already imported keeps one instance.
 */
function lazyHandler(options: TestWorldOptions): Handler {
  let loading: Promise<Handler> | undefined;
  return async (request) => {
    loading ??= loadFlowRoute(options);
    return await (
      await loading
    )(request);
  };
}

async function loadFlowRoute({ namespace, outDir }: TestWorldOptions): Promise<Handler> {
  await import(/* @vite-ignore */ pathToFileURL(join(outDir, "steps.mjs")).href);
  const code = await readFile(workflowDriverCodePath(join(outDir, "workflows.mjs")), "utf8");
  return workflowEntrypoint(code, { namespace });
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createWorld } from "@workflow/world-local";

import {
  readLocalWorldWaits,
  rewriteLocalWorldRunAttributes,
  type StoredWait,
} from "#internal/testing/local-world-database.js";
import { workflowDriverCodePath } from "#internal/workflow-bundle/builder-support.js";
import { setWorld, workflowEntrypoint } from "#internal/workflow/runtime.js";

type LocalWorld = ReturnType<typeof createWorld>;
type Handler = (request: Request) => Promise<Response>;

export interface TestWorldOptions {
  readonly dataDir: string;
  readonly tag: string;
  readonly prefix: string;
  readonly outDir: string;
  readonly namespace: string;
}

export interface TestWorld {
  readonly world: LocalWorld;
  idle(): Promise<void>;
  redeliverNextFailure(): void;
  restart(options?: { readonly beforeStart?: () => Promise<void> }): Promise<string[]>;
  activeRunIds(): Promise<string[]>;
  storedWaits(): Promise<StoredWait[]>;
  rewriteRunAttributes(runId: string, patch: Record<string, string | undefined>): Promise<void>;
  close(): Promise<void>;
}

const CURRENT = Symbol.for("eve.testing.workflow-test-world");

export function currentTestWorld(): TestWorld {
  const world = (globalThis as { [CURRENT]?: TestWorld })[CURRENT];
  if (world === undefined) throw new Error("No Workflow test World is open in this file.");
  return world;
}

export async function openTestWorld(options: TestWorldOptions): Promise<TestWorld> {
  const deliveries = trackDeliveries(lazyHandler(options));
  let world = await startWorld(options, deliveries, {});
  await world.clear();

  const testWorld: TestWorld = {
    get world() {
      return world;
    },
    idle: () => deliveries.idle(),
    redeliverNextFailure: () => deliveries.redeliverNextFailure(),
    async restart({ beforeStart } = {}) {
      const { guardStrandedSessionReplay } =
        await import("#execution/session-inbox/stranded-replay-guard.js");
      const recovering = await activeRunIds(world);
      deliveries.abandon();
      await world.close?.();
      fenceClosedWorld(world);
      setWorld(undefined);
      newRealm();
      await beforeStart?.();
      deliveries.reopen(recovering, lazyHandler(options));
      world = await startWorld(options, deliveries, { guard: guardStrandedSessionReplay });
      return recovering;
    },
    activeRunIds: () => activeRunIds(world),
    storedWaits: async () => readLocalWorldWaits(options.dataDir, options.tag),
    rewriteRunAttributes: async (runId, patch) =>
      rewriteLocalWorldRunAttributes(options.dataDir, runId, patch),
    async close() {
      await deliveries.close();
      await world.close?.();
      fenceClosedWorld(world);
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
  {
    guard,
  }: {
    readonly guard?: (world: LocalWorld) => LocalWorld;
  },
): Promise<LocalWorld> {
  const created = createWorld({
    dataDir: options.dataDir,
    recoverActiveRuns: guard !== undefined,
    tag: options.tag,
  });
  const world = guard === undefined ? created : guard(created);
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

export function fenceClosedWorld(world: object): void {
  const refuse = () => {
    throw new Error("This World is closed: the process that opened it is gone.");
  };
  const fence = (target: Record<string, unknown>) => {
    for (const key of Object.keys(target)) {
      if (typeof target[key] === "function") target[key] = refuse;
    }
  };
  fence(world as Record<string, unknown>);
  for (const value of Object.values(world)) {
    if (value !== null && typeof value === "object") fence(value as Record<string, unknown>);
  }
}

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

function newRealm(): void {
  const store = globalThis as Record<symbol, unknown>;
  const boot = store[Symbol.for("@workflow/world-local//realmBoot/v1")] as
    | { bootedAt: number }
    | undefined;
  if (boot !== undefined) boot.bootedAt = Date.now();
  const singleFlight = store[Symbol.for("@workflow/core//stepSingleFlight/v2")] as
    | { inFlight: Map<string, unknown> }
    | undefined;
  singleFlight?.inFlight.clear();
}

export interface Deliveries {
  readonly handler: Handler;
  queued(messageId: string, delayed: boolean): void;
  idle(): Promise<void>;
  redeliverNextFailure(): void;
  abandon(): void;
  reopen(recovering: readonly string[], handle: Handler): void;
  close(): Promise<void>;
}

export function trackDeliveries(initial: Handler): Deliveries {
  let handle = initial;
  const due = new Set<string>();
  const seen = new Set<string>();
  const recovering = new Set<string>();
  let running = 0;
  let generation = 0;
  let closing = false;
  let redeliver = 0;
  const waiters = new Set<() => void>();

  const busy = () => running > 0 || recovering.size > 0 || due.size > 0;
  const wake = () => {
    if (busy()) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  const afterResponse = async (messageId: string, response: Response) => {
    if (!response.ok) {
      due.add(messageId);
      return;
    }
    const text = await response.clone().text();
    if (!text.includes("timeoutSeconds")) return;
    const timeoutSeconds = Number(
      (JSON.parse(text) as { timeoutSeconds?: unknown }).timeoutSeconds,
    );
    if (timeoutSeconds === 0) due.add(messageId);
  };

  const redeliverAtOnce = () => {
    redeliver -= 1;
    return Response.json({ timeoutSeconds: 0 });
  };

  const handler: Handler = async (request) => {
    if (closing) throw new DOMException("The test workflow world is closing.", "AbortError");
    const messageId = request.headers.get("x-vqs-message-id") ?? "";
    const ours = generation;
    seen.add(messageId);
    due.delete(messageId);
    running += 1;
    try {
      let delivery = request;
      if (recovering.size > 0) {
        const body = await request.text();
        const runId = runIdOf(body);
        if (runId !== undefined) recovering.delete(runId);
        delivery = new Request(request.url, { body, headers: request.headers, method: "POST" });
      }
      const response = await handle(delivery);
      if (ours !== generation) return response;
      const answer = !response.ok && redeliver > 0 ? redeliverAtOnce() : response;
      await afterResponse(messageId, answer);
      return answer;
    } finally {
      if (ours === generation) {
        running -= 1;
        setImmediate(wake);
      }
    }
  };

  return {
    handler,
    queued(messageId, delayed) {
      if (delayed || seen.has(messageId)) return;
      seen.add(messageId);
      due.add(messageId);
    },
    async idle() {
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
  const { installWorkflowHost } = await import("#execution/workflow-host/host.js");
  installWorkflowHost();
  const code = await readFile(workflowDriverCodePath(join(outDir, "workflows.mjs")), "utf8");
  return workflowEntrypoint(code, { namespace });
}

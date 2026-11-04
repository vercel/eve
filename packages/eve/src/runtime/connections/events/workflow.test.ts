import { beforeEach, expect, it, vi } from "vitest";

import type { EventBinding } from "./state.js";

/** A deterministic stand-in for Workflow's hooks and sleep: one owner per token. */
const world = vi.hoisted(() => {
  class FakeHook<T> {
    readonly queue: T[] = [];
    waiter: (() => void) | undefined;
    readonly token: string;
    readonly id: string;
    readonly metadata: unknown;
    readonly options: object;
    conflict: string | null = null;
    private readonly owners: Map<string, FakeHook<unknown>>;
    constructor(
      token: string,
      owners: Map<string, FakeHook<unknown>>,
      options: { id: string; metadata: unknown; options: object },
    ) {
      this.token = token;
      this.owners = owners;
      this.id = options.id;
      this.metadata = options.metadata;
      this.options = options.options;
    }
    push(value: T) {
      this.queue.push(value);
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter?.();
    }
    async next(): Promise<T> {
      while (this.queue.length === 0) await new Promise<void>((resolve) => (this.waiter = resolve));
      return this.queue.shift()!;
    }
    // oxlint-disable-next-line unicorn/no-thenable -- Workflow hooks are awaited for their first payload.
    then<R>(resolve: (value: T) => R, reject: (error: unknown) => R) {
      return this.next().then(resolve, reject);
    }
    async getConflict() {
      return this.conflict === null ? null : { runId: this.conflict };
    }
    async dispose() {
      if (this.owners.get(this.token) === this) this.owners.delete(this.token);
    }
  }
  const owners = new Map<string, FakeHook<unknown>>();
  let created = 0;
  let expire: (() => void) | undefined;
  return {
    owners,
    createHook(options: { token: string; metadata?: unknown }) {
      const previous = owners.get(options.token);
      const hook = new FakeHook<unknown>(options.token, owners, {
        id: `hook-${++created}`,
        metadata: options.metadata,
        options,
      });
      // A held token conflicts; the hook reports which owner holds it.
      if (previous !== undefined) {
        hook.conflict = previous.id;
        return hook;
      }
      owners.set(options.token, hook);
      return hook;
    },
    resume(token: string, value: unknown) {
      const hook = owners.get(token);
      if (hook === undefined) throw new Error(`test world: no hook for ${token}`);
      hook.push(value);
    },
    sleeps: [] as Date[],
    backoffs: [] as number[],
    sleep(until: Date | number) {
      // A finite delay is the unsubscribe backoff; a date is the watch's expiry.
      if (typeof until === "number") {
        world.backoffs.push(until);
        return Promise.resolve();
      }
      world.sleeps.push(until);
      return new Promise<void>((resolve) => (expire = resolve));
    },
    expire: () => expire?.(),
    expiresAt: null as string | null,
    followed: [] as string[],
    /** Settles the watch's subscribe step; tests hold it to model a slow Connect. */
    subscribed: Promise.resolve() as Promise<void>,
    refuse: false,
    unsubscribed: vi.fn(async (_input: unknown): Promise<"pending" | "done"> => "done"),
    started: vi.fn(async (_input: unknown) => {}),
    dispatch: vi.fn(async (_input: unknown) => {}),
  };
});

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: world.createHook,
  sleep: world.sleep,
}));
vi.mock("#runtime/connections/events/dispatch-step.js", () => ({
  dispatchConnectionEventStep: world.dispatch,
}));
vi.mock("#runtime/connections/events/lifecycle-step.js", () => ({
  async openConnectionEventStep() {
    await world.subscribed;
    return world.refuse
      ? { error: "Unauthorized", status: 401 }
      : {
          subscription: {
            id: "sub_1",
            name: "issue.created",
            status: "active",
            expiresAt: world.expiresAt,
          },
        };
  },
  async publishConnectionEventOutcomeStep(outcome: { ownerRunId?: string }) {
    if (outcome.ownerRunId !== undefined) world.followed.push(outcome.ownerRunId);
  },
  unsubscribeConnectionEventStep: world.unsubscribed,
  startConnectionEventDeliveryStep: world.started,
}));

const { connectionEventWorkflow, connectionEventDeliveryWorkflow } = await import("./workflow.js");
const { connectionEventHookToken } = await import("./path.js");

const binding = { id: "binding-1", request: { ttlMs: 3_600_000 } } as EventBinding;
const token = connectionEventHookToken(binding.id);
const watching = () => vi.waitFor(() => expect(world.owners.has(token)).toBe(true));
const delivery = (subscriptionId: string) => ({
  kind: "delivery" as const,
  payload: {
    kind: "connection-event",
    bindingId: binding.id,
    delivery: { deliveryId: `delivery-${subscriptionId}`, subscriptionId },
  },
});

beforeEach(() => {
  world.owners.clear();
  world.sleeps.length = 0;
  world.backoffs.length = 0;
  world.followed.length = 0;
  world.expiresAt = null;
  world.refuse = false;
  world.subscribed = Promise.resolve();
  world.unsubscribed.mockReset().mockResolvedValue("done");
  world.started.mockReset();
  world.dispatch.mockReset();
});

it("holds the binding in a hook that ends with the run", async () => {
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  const hook = world.owners.get(token)!;
  expect(hook.metadata).toEqual(binding);
  // No retention: once the run ends, the watch is not found.
  expect(hook.options).not.toHaveProperty("experimental_minRetention");
  world.resume(token, { kind: "retire" });
  await run;
});

it("unsubscribes when stopped, and ends only once Connect finishes cleanup", async () => {
  world.unsubscribed
    .mockResolvedValueOnce("pending")
    .mockResolvedValueOnce("pending")
    .mockResolvedValueOnce("done");
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  world.resume(token, { kind: "retire" });
  await run;
  expect(world.unsubscribed).toHaveBeenCalledTimes(3);
  expect(world.unsubscribed).toHaveBeenCalledWith({
    serializedContext: {},
    binding,
    subscriptionId: "sub_1",
  });
  // Each repeat waits durably, longer each time.
  expect(world.backoffs).toEqual([5_000, 10_000]);
});

it("keeps the watch through repeated failed unsubscribes until Connect's cleanup completes", async () => {
  let attempts = 0;
  world.unsubscribed.mockImplementation(async () => {
    // Every failed attempt leaves the watch reachable for get and stop.
    expect(world.owners.has(token)).toBe(true);
    return ++attempts <= 5 ? "pending" : "done";
  });
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  world.resume(token, { kind: "retire" });
  await run;
  expect(world.unsubscribed).toHaveBeenCalledTimes(6);
  expect(world.backoffs).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);
});

it("takes a stop that arrives before the subscribe response, then unsubscribes what it created", async () => {
  let respond!: () => void;
  world.subscribed = new Promise((resolve) => (respond = resolve));
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  world.resume(token, { kind: "retire" });
  respond();
  await run;
  expect(world.unsubscribed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ subscriptionId: "sub_1" }),
  );
});

it("starts a delivery that beat the subscribe response once, and drops another subscription's", async () => {
  let respond!: () => void;
  world.subscribed = new Promise((resolve) => (respond = resolve));
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  world.resume(token, delivery("sub_other"));
  world.resume(token, delivery("sub_1"));
  await Promise.resolve();
  expect(world.started).not.toHaveBeenCalled();
  respond();
  await vi.waitFor(() => expect(world.started).toHaveBeenCalledTimes(1));
  expect(world.started).toHaveBeenCalledWith({
    binding,
    serializedContext: {},
    payload: delivery("sub_1").payload,
  });
  world.resume(token, { kind: "retire" });
  await run;
  expect(world.started).toHaveBeenCalledTimes(1);
});

it("ends the watch at its subscription's expiry without unsubscribing", async () => {
  world.expiresAt = "2026-10-08T00:00:00.000Z";
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await vi.waitFor(() => expect(world.sleeps).toHaveLength(1));
  expect(world.sleeps[0]).toEqual(new Date(world.expiresAt));
  world.expire();
  await run;
  expect(world.unsubscribed).not.toHaveBeenCalled();
});

it("runs each delivery in its own run, so a failed callback leaves the watch to a later stop", async () => {
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  const live = world.owners.get(token);
  const input = {
    binding,
    serializedContext: {},
    payload: { kind: "connection-event", delivery: { deliveryId: "delivery-1" } },
  } as Parameters<typeof connectionEventDeliveryWorkflow>[0];
  world.dispatch.mockRejectedValueOnce(new Error("callback failed"));
  await expect(connectionEventDeliveryWorkflow(input)).rejects.toThrow("callback failed");
  await connectionEventDeliveryWorkflow(input);
  expect(world.dispatch).toHaveBeenCalledWith(input);
  // The watch's run saw neither delivery and still holds its hook.
  expect(world.owners.get(token)).toBe(live);
  expect(live?.queue).toEqual([]);
  world.resume(token, { kind: "retire" });
  await run;
});

it("points a second run for the same watch at the run that owns it", async () => {
  const first = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  const owner = world.owners.get(token)!.id;
  await connectionEventWorkflow({ binding, serializedContext: {} });
  expect(world.followed).toEqual([owner]);
  expect(world.owners.get(token)?.id).toBe(owner);
  world.resume(token, { kind: "retire" });
  await first;
});

it("ends a run whose subscribe Connect refused, releasing its token", async () => {
  world.refuse = true;
  await connectionEventWorkflow({ binding, serializedContext: {} });
  expect(world.owners.has(token)).toBe(false);
});

import { beforeEach, expect, it, vi } from "vitest";

import type { ConnectionEventWatch, EventBinding } from "./state.js";

/** A deterministic stand-in for Workflow's hooks and sleep: one owner per token. */
const world = vi.hoisted(() => {
  class FakeHook<T> {
    readonly queue: T[] = [];
    waiter: (() => void) | undefined;
    readonly token: string;
    readonly id: string;
    readonly metadata: unknown;
    readonly retained: boolean;
    conflict: string | null = null;
    private readonly owners: Map<string, FakeHook<unknown>>;
    constructor(
      token: string,
      owners: Map<string, FakeHook<unknown>>,
      options: { id: string; metadata: unknown; retained: boolean },
    ) {
      this.token = token;
      this.owners = owners;
      this.id = options.id;
      this.metadata = options.metadata;
      this.retained = options.retained;
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
    createHook(options: {
      token: string;
      metadata?: unknown;
      experimental_minRetention?: unknown;
    }) {
      const previous = owners.get(options.token);
      const hook = new FakeHook<unknown>(options.token, owners, {
        id: `hook-${++created}`,
        metadata: options.metadata,
        retained: options.experimental_minRetention !== undefined,
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
    sleep(until: Date) {
      world.sleeps.push(until);
      return new Promise<void>((resolve) => (expire = resolve));
    },
    expire: () => expire?.(),
    expiresAt: null as string | null,
    followed: [] as string[],
    refuse: false,
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
}));

const { connectionEventWorkflow, connectionEventDeliveryWorkflow } = await import("./workflow.js");
const { connectionEventHookToken } = await import("./path.js");

const binding = { id: "binding-1" } as EventBinding;
const token = connectionEventHookToken(binding.id);
const watching = () => vi.waitFor(() => expect(world.owners.has(token)).toBe(true));
const watch = () => world.owners.get(token)!.metadata as ConnectionEventWatch;

beforeEach(() => {
  world.owners.clear();
  world.sleeps.length = 0;
  world.followed.length = 0;
  world.expiresAt = null;
  world.refuse = false;
  world.dispatch.mockReset();
});

it("holds the binding in its hook until stopped, then keeps an ended hook findable", async () => {
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  expect(watch()).toEqual({ binding, ended: false });
  world.resume(token, { kind: "retire" });
  await run;
  expect(world.owners.get(token)?.retained).toBe(true);
  expect(watch()).toEqual({ binding, ended: true });
});

it("ends the watch at its subscription's expiry", async () => {
  world.expiresAt = "2026-10-08T00:00:00.000Z";
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await vi.waitFor(() => expect(world.sleeps).toHaveLength(1));
  expect(world.sleeps[0]).toEqual(new Date(world.expiresAt));
  world.expire();
  await run;
  expect(watch()).toEqual({ binding, ended: true });
});

it("runs each delivery in its own run, so a failed callback leaves the watch to a later stop", async () => {
  const run = connectionEventWorkflow({ binding, serializedContext: {} });
  await watching();
  const live = world.owners.get(token);
  const delivery = {
    binding,
    serializedContext: {},
    payload: { kind: "connection-event", delivery: { deliveryId: "delivery-1" } },
  } as Parameters<typeof connectionEventDeliveryWorkflow>[0];
  world.dispatch.mockRejectedValueOnce(new Error("callback failed"));
  await expect(connectionEventDeliveryWorkflow(delivery)).rejects.toThrow("callback failed");
  await connectionEventDeliveryWorkflow(delivery);
  expect(world.dispatch).toHaveBeenCalledWith(delivery);
  // The watch's run saw neither delivery and still holds its hook.
  expect(world.owners.get(token)).toBe(live);
  expect(live?.queue).toEqual([]);
  world.resume(token, { kind: "retire" });
  await run;
  expect(watch().ended).toBe(true);
});

it("points a duplicate run's caller at the run that owns the watch", async () => {
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

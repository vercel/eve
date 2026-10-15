import { beforeEach, expect, it, vi } from "vitest";

import type { ConnectionEventHandlerState, EventBinding } from "./state.js";

/**
 * A deterministic stand-in for Workflow's hooks: one owner per token, and a
 * forced claim fails the previous owner once it has drained what it received.
 */
const world = vi.hoisted(() => {
  class FakeHook<T> {
    readonly queue: T[] = [];
    waiter: (() => void) | undefined;
    takenOver = false;
    readonly token: string;
    readonly id: string;
    readonly retained: boolean;
    conflict: string | null = null;
    private readonly owners: Map<string, FakeHook<unknown>>;
    constructor(
      token: string,
      owners: Map<string, FakeHook<unknown>>,
      options: { id: string; retained: boolean },
    ) {
      this.token = token;
      this.owners = owners;
      this.id = options.id;
      this.retained = options.retained;
    }
    push(value: T) {
      this.queue.push(value);
      this.wake();
    }
    takeOver() {
      this.takenOver = true;
      this.wake();
    }
    private wake() {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter?.();
    }
    async next(): Promise<IteratorResult<T>> {
      for (;;) {
        if (this.queue.length > 0) return { done: false, value: this.queue.shift()! };
        if (this.takenOver) throw { name: "HookForceClaimedError", token: this.token };
        await new Promise<void>((resolve) => (this.waiter = resolve));
      }
    }
    [Symbol.asyncIterator]() {
      return { next: () => this.next() };
    }
    // oxlint-disable-next-line unicorn/no-thenable -- Workflow hooks are awaited for their first payload.
    then<R>(resolve: (value: T) => R, reject: (error: unknown) => R) {
      return this.next().then((result) => resolve(result.value), reject);
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
  return {
    owners,
    createHook(options: {
      token: string;
      experimental_force?: boolean;
      experimental_minRetention?: unknown;
    }) {
      const previous = owners.get(options.token);
      const hook = new FakeHook<unknown>(options.token, owners, {
        id: `hook-${++created}`,
        retained: options.experimental_minRetention !== undefined,
      });
      // Without force, a held token conflicts; the hook reports which owner holds it.
      if (previous !== undefined && !options.experimental_force) {
        hook.conflict = previous.id;
        return hook;
      }
      owners.set(options.token, hook);
      previous?.takeOver();
      return hook;
    },
    resume(token: string, value: unknown) {
      const hook = owners.get(token);
      if (hook === undefined) throw new Error(`test world: no hook for ${token}`);
      hook.push(value);
    },
    /** What each delivery saw when its run prepared it. */
    seen: [] as { id: string; count: number; receipts: number }[],
    successors: [] as (() => Promise<void>)[],
    followed: [] as string[],
    refuse: false,
  };
});

vi.mock("#compiled/@workflow/core/index.js", () => ({ createHook: world.createHook }));
vi.mock("#runtime/connections/events/dispatch-step.js", () => ({
  // The callback state: how many deliveries this watch's handler has run.
  async dispatchConnectionEventStep(input: {
    serializedContext: { count?: number };
    state: ConnectionEventHandlerState;
    payload: { delivery: { deliveryId: string } };
  }) {
    const id = input.payload.delivery.deliveryId;
    world.seen.push({
      id,
      count: input.serializedContext.count ?? 0,
      receipts: input.state.receipts.length,
    });
    return {
      accepted: true,
      serializedContext: { count: (input.serializedContext.count ?? 0) + 1 },
      state: { ...input.state, receipts: [...input.state.receipts, id] },
    };
  },
}));
vi.mock("#runtime/connections/events/lifecycle-step.js", async () => {
  const { connectionEventHandoverToken } = await import("./path.js");
  return {
    async openConnectionEventStep() {
      return world.refuse
        ? { error: "Unauthorized", status: 401 }
        : { subscription: { id: "sub_1", name: "issue.created", status: "active" } };
    },
    // The test decides when the successor starts, to place deliveries before its takeover.
    async startConnectionEventSuccessorStep(input: { binding: EventBinding }) {
      world.successors.push(async () =>
        (await import("./workflow.js")).connectionEventWorkflow(
          input as Parameters<typeof import("./workflow.js").connectionEventWorkflow>[0],
        ),
      );
    },
    async publishConnectionEventOutcomeStep(outcome: { ownerRunId?: string }) {
      if (outcome.ownerRunId !== undefined) world.followed.push(outcome.ownerRunId);
    },
    async passConnectionEventHandoverStep(input: {
      bindingId: string;
      generation: number;
      handover: unknown;
    }) {
      world.resume(connectionEventHandoverToken(input.bindingId, input.generation), input.handover);
    },
  };
});

const { CONNECTION_EVENT_HANDOVER_DELIVERIES, connectionEventWorkflow } =
  await import("./workflow.js");
const { connectionEventHookToken } = await import("./path.js");

const binding = { id: "binding-1" } as EventBinding;
const token = connectionEventHookToken(binding.id);
const deliver = (id: number) =>
  world.resume(token, { kind: "connection-event", delivery: { deliveryId: `delivery-${id}` } });
const seenThrough = (id: number) =>
  vi.waitFor(() => expect(world.seen.at(-1)?.id).toBe(`delivery-${id}`));

beforeEach(() => {
  world.owners.clear();
  world.seen.length = 0;
  world.successors.length = 0;
  world.followed.length = 0;
  world.refuse = false;
});

it("hands the successor the state and receipts of every delivery its predecessor processed", async () => {
  const first = connectionEventWorkflow({ binding, serializedContext: {} });
  await vi.waitFor(() => expect(world.owners.has(token)).toBe(true));
  for (let id = 1; id <= CONNECTION_EVENT_HANDOVER_DELIVERIES; id++) deliver(id);
  await vi.waitFor(() => expect(world.successors).toHaveLength(1));
  // Reaches the predecessor after it asked for a successor, before the takeover.
  const late = CONNECTION_EVENT_HANDOVER_DELIVERIES + 1;
  deliver(late);
  await seenThrough(late);
  const successor = world.successors[0]!();
  await first;
  deliver(late + 1);
  await seenThrough(late + 1);
  expect(world.seen.at(-1)).toEqual({ id: `delivery-${late + 1}`, count: late, receipts: late });
  // Each delivery ran once, in order, across both runs.
  expect(world.seen.map(({ id }) => id)).toEqual(
    Array.from({ length: late + 1 }, (_, index) => `delivery-${index + 1}`),
  );
  world.resume(token, { kind: "retire" });
  await successor;
  expect(world.owners.get(token)?.retained).toBe(true);
});

it("ends the successor too when the watch stopped before the takeover", async () => {
  const first = connectionEventWorkflow({ binding, serializedContext: {} });
  await vi.waitFor(() => expect(world.owners.has(token)).toBe(true));
  for (let id = 1; id <= CONNECTION_EVENT_HANDOVER_DELIVERIES; id++) deliver(id);
  await vi.waitFor(() => expect(world.successors).toHaveLength(1));
  world.resume(token, { kind: "retire" });
  const successor = world.successors[0]!();
  await Promise.all([first, successor]);
  // The successor took the token, so it is the one that keeps the ended watch findable.
  expect(world.owners.get(token)?.retained).toBe(true);
});

it("points a duplicate run's caller at the run that owns the watch", async () => {
  const first = connectionEventWorkflow({ binding, serializedContext: {} });
  await vi.waitFor(() => expect(world.owners.has(token)).toBe(true));
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

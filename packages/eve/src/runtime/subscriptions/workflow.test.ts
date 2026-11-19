import { beforeEach, expect, it, vi } from "vitest";

import {
  subscriptionHookToken,
  subscriptionKeyHookToken,
  type OpenOutcome,
  type SubscriptionBinding,
} from "./state.js";

const world = vi.hoisted(() => {
  class FakeHook<T> {
    readonly queue: T[] = [];
    waiter: (() => void) | undefined;
    readonly token: string;
    readonly id: string;
    readonly metadata: unknown;
    conflict: string | null = null;
    disposed = false;
    private readonly owners: Map<string, FakeHook<unknown>>;
    constructor(
      token: string,
      owners: Map<string, FakeHook<unknown>>,
      options: { id: string; metadata: unknown },
    ) {
      this.token = token;
      this.owners = owners;
      this.id = options.id;
      this.metadata = options.metadata;
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
      this.disposed = true;
      if (this.owners.get(this.token) === this) this.owners.delete(this.token);
    }
  }
  const owners = new Map<string, FakeHook<unknown>>();
  let created = 0;
  let expire: (() => void) | undefined;
  return {
    owners,
    hooks: [] as FakeHook<unknown>[],
    calls: [] as string[],
    createHook(options: { token: string; metadata?: unknown }) {
      const previous = owners.get(options.token);
      const hook = new FakeHook<unknown>(options.token, owners, {
        id: `hook-${++created}`,
        metadata: options.metadata,
      });
      world.hooks.push(hook);
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
      if (typeof until === "number") {
        world.backoffs.push(until);
        return Promise.resolve();
      }
      world.sleeps.push(until);
      return new Promise<void>((resolve) => (expire = resolve));
    },
    expire: () => expire?.(),
    publishedOwners: [] as string[],
    outcome: null as unknown as OpenOutcome,
    open: vi.fn(async (_input: unknown) => world.outcome),
    publishOwner: vi.fn(async (runId: string) => {
      world.publishedOwners.push(runId);
    }),
    join: vi.fn(async (_input: unknown) => {}),
    leave: vi.fn(async (_input: unknown) => {}),
    close: vi.fn(async (_input: unknown): Promise<"pending" | "done"> => "done"),
    start: vi.fn(async (_input: unknown) => {}),
    dispatch: vi.fn(async (_input: unknown) => {}),
    acknowledge: vi.fn(async (_ackId: string) => {}),
    forward: vi.fn(async (_input: unknown) => {}),
    fanOut: vi.fn(async (_input: unknown): Promise<string[]> => []),
  };
});

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: world.createHook,
  sleep: world.sleep,
}));
vi.mock("#runtime/subscriptions/steps.js", () => ({
  acknowledgeJoinStep: world.acknowledge,
  closeSubscriptionStep: async (input: unknown) => {
    world.calls.push("close");
    return await world.close(input);
  },
  dispatchSubscriptionStep: world.dispatch,
  fanOutEventStep: world.fanOut,
  forwardJoinStep: world.forward,
  joinKeyStep: async (input: unknown) => {
    world.calls.push("join");
    await world.join(input);
  },
  leaveKeyStep: async (input: unknown) => {
    world.calls.push("leave");
    await world.leave(input);
  },
  openSubscriptionStep: async (input: unknown) => {
    world.calls.push("open");
    return await world.open(input);
  },
  publishSubscriptionOwnerStep: world.publishOwner,
  startSubscriptionDeliveryStep: world.start,
}));

const { subscriptionWorkflow, subscriptionKeyWorkflow, subscriptionDeliveryWorkflow } =
  await import("./workflow.js");

const binding: SubscriptionBinding = {
  id: "binding-1",
  source: {
    kind: "channel",
    name: "github",
    event: "checks_finished",
    key: "vercel/eve#7",
    input: {},
    ttlMs: null,
  },
  sessionId: "session-1",
  executionPrincipal: "principal-1",
  auth: null,
};
const source = { kind: "channel", name: "github" } as const;
const key = "vercel/eve#7";
const ownerToken = subscriptionHookToken(binding.id);
const keyToken = subscriptionKeyHookToken(source, key);
const serializedContext = {};
const event = (id: string) => ({ id, data: { id } });
const opened = (expiresAt: string | null = null): OpenOutcome => ({ opened: { key, expiresAt } });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const watching = (token: string) => vi.waitFor(() => expect(world.owners.has(token)).toBe(true));
const keyRun = (first: string, ackId: string) =>
  subscriptionKeyWorkflow({ source, key, first, ackId });

beforeEach(() => {
  world.owners.clear();
  world.hooks.length = 0;
  world.calls.length = 0;
  world.sleeps.length = 0;
  world.backoffs.length = 0;
  world.publishedOwners.length = 0;
  world.outcome = opened();
  for (const fn of [
    world.open,
    world.publishOwner,
    world.join,
    world.leave,
    world.start,
    world.dispatch,
    world.acknowledge,
    world.forward,
    world.fanOut,
  ])
    fn.mockClear();
  world.close.mockReset().mockResolvedValue("done");
  world.fanOut.mockResolvedValue([]);
});

it("claims the hook for its binding, opens, then joins the key the source opened", async () => {
  const run = subscriptionWorkflow({ binding, serializedContext });
  await watching(ownerToken);
  await vi.waitFor(() => expect(world.join).toHaveBeenCalled());
  expect(world.owners.get(ownerToken)!.metadata).toEqual(binding);
  expect(world.open).toHaveBeenCalledWith({ binding, serializedContext });
  expect(world.join).toHaveBeenCalledExactlyOnceWith({ binding, key });
  expect(world.calls).toEqual(["open", "join"]);

  world.resume(ownerToken, { kind: "retire" });
  await run;
});

it("forwards each delivery to the delivery step", async () => {
  const run = subscriptionWorkflow({ binding, serializedContext });
  await vi.waitFor(() => expect(world.join).toHaveBeenCalled());
  world.resume(ownerToken, { kind: "delivery", event: event("a") });
  await vi.waitFor(() => expect(world.start).toHaveBeenCalledTimes(1));
  expect(world.start).toHaveBeenCalledWith({ binding, serializedContext, event: event("a") });

  world.resume(ownerToken, { kind: "retire" });
  await run;
  expect(world.start).toHaveBeenCalledTimes(1);
});

it("leaves its key, then closes, when it is retired", async () => {
  const run = subscriptionWorkflow({ binding, serializedContext });
  await vi.waitFor(() => expect(world.join).toHaveBeenCalled());
  world.resume(ownerToken, { kind: "retire" });
  await run;

  expect(world.calls).toEqual(["open", "join", "leave", "close"]);
  expect(world.leave).toHaveBeenCalledExactlyOnceWith({ binding, key });
  expect(world.close).toHaveBeenCalledExactlyOnceWith({
    binding,
    serializedContext,
    opened: { key, expiresAt: null },
  });
  expect(world.sleeps).toEqual([]);
  expect(world.backoffs).toEqual([]);
});

it("ends at the expiry the source reported, then leaves and closes", async () => {
  const expiresAt = "2026-10-08T00:00:00.000Z";
  world.outcome = opened(expiresAt);
  const run = subscriptionWorkflow({ binding, serializedContext });
  await vi.waitFor(() => expect(world.sleeps).toHaveLength(1));
  expect(world.sleeps[0]).toEqual(new Date(expiresAt));
  world.expire();
  await run;

  expect(world.calls).toEqual(["open", "join", "leave", "close"]);
  expect(world.start).not.toHaveBeenCalled();
});

it("closes again with doubling backoff while the source reports the close pending", async () => {
  world.close
    .mockResolvedValueOnce("pending")
    .mockResolvedValueOnce("pending")
    .mockResolvedValueOnce("done");
  const run = subscriptionWorkflow({ binding, serializedContext });
  await vi.waitFor(() => expect(world.join).toHaveBeenCalled());
  world.resume(ownerToken, { kind: "retire" });
  await run;

  expect(world.close).toHaveBeenCalledTimes(3);
  expect(world.backoffs).toEqual([5_000, 10_000]);
});

it("caps the close backoff at one hour", async () => {
  let attempts = 0;
  world.close.mockImplementation(async () => (++attempts <= 12 ? "pending" : "done"));
  const run = subscriptionWorkflow({ binding, serializedContext });
  await vi.waitFor(() => expect(world.join).toHaveBeenCalled());
  world.resume(ownerToken, { kind: "retire" });
  await run;

  expect(world.backoffs).toEqual([
    5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 2_560_000,
    3_600_000, 3_600_000,
  ]);
});

it("publishes the run that already owns the binding and ends without opening", async () => {
  const first = subscriptionWorkflow({ binding, serializedContext });
  await vi.waitFor(() => expect(world.join).toHaveBeenCalled());
  const ownerHookId = world.owners.get(ownerToken)!.id;
  world.open.mockClear();
  world.join.mockClear();

  await subscriptionWorkflow({ binding, serializedContext });
  expect(world.publishOwner).toHaveBeenCalledExactlyOnceWith(ownerHookId);
  expect(world.open).not.toHaveBeenCalled();
  expect(world.join).not.toHaveBeenCalled();
  expect(world.owners.get(ownerToken)!.id).toBe(ownerHookId);

  world.resume(ownerToken, { kind: "retire" });
  await first;
});

it("disposes its hook and ends without joining when the source refuses to open", async () => {
  world.outcome = { error: "Unauthorized", status: 401 };
  await subscriptionWorkflow({ binding, serializedContext });

  expect(world.owners.has(ownerToken)).toBe(false);
  expect(world.hooks.at(-1)!.disposed).toBe(true);
  expect(world.join).not.toHaveBeenCalled();
  expect(world.leave).not.toHaveBeenCalled();
  expect(world.close).not.toHaveBeenCalled();
});

it("acknowledges its first subscription and fans each event out to every member once", async () => {
  const run = keyRun("a", "ack-a");
  await watching(keyToken);
  await vi.waitFor(() => expect(world.acknowledge).toHaveBeenCalledWith("ack-a"));

  world.resume(keyToken, { kind: "join", bindingId: "b", ackId: "ack-b" });
  world.resume(keyToken, { kind: "emit", event: event("e1") });
  world.resume(keyToken, { kind: "emit", event: event("e1") });
  await vi.waitFor(() => expect(world.fanOut).toHaveBeenCalled());
  await settle();

  expect(world.acknowledge.mock.calls).toEqual([["ack-a"], ["ack-b"]]);
  expect(world.fanOut).toHaveBeenCalledExactlyOnceWith({
    bindingIds: ["a", "b"],
    event: event("e1"),
  });

  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  world.resume(keyToken, { kind: "leave", bindingId: "b" });
  await run;
});

it("sends later events to a member that joined after the first", async () => {
  const run = keyRun("a", "ack-a");
  await watching(keyToken);
  world.resume(keyToken, { kind: "emit", event: event("e1") });
  await vi.waitFor(() => expect(world.fanOut).toHaveBeenCalledTimes(1));
  world.resume(keyToken, { kind: "join", bindingId: "b", ackId: "ack-b" });
  world.resume(keyToken, { kind: "emit", event: event("e2") });
  await vi.waitFor(() => expect(world.fanOut).toHaveBeenCalledTimes(2));

  expect(world.fanOut.mock.calls.map(([input]) => input)).toEqual([
    { bindingIds: ["a"], event: event("e1") },
    { bindingIds: ["a", "b"], event: event("e2") },
  ]);

  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  world.resume(keyToken, { kind: "leave", bindingId: "b" });
  await run;
});

it("forgets the oldest event id after 256 distinct ones", async () => {
  const run = keyRun("a", "ack-a");
  await watching(keyToken);
  for (let index = 0; index < 257; index += 1)
    world.resume(keyToken, { kind: "emit", event: event(`e${index}`) });
  await vi.waitFor(() => expect(world.fanOut).toHaveBeenCalledTimes(257));

  world.resume(keyToken, { kind: "emit", event: event("e256") });
  world.resume(keyToken, { kind: "emit", event: event("e1") });
  world.resume(keyToken, { kind: "emit", event: event("e0") });
  await vi.waitFor(() => expect(world.fanOut).toHaveBeenCalledTimes(258));
  await settle();

  expect(world.fanOut).toHaveBeenCalledTimes(258);
  expect(world.fanOut.mock.calls.at(-1)![0]).toEqual({ bindingIds: ["a"], event: event("e0") });

  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  await run;
});

it("keeps running when a member other than the last leaves, and ends when the last one does", async () => {
  const run = keyRun("a", "ack-a");
  let ended = false;
  void run.then(() => (ended = true));
  await watching(keyToken);
  const hook = world.owners.get(keyToken)!;

  world.resume(keyToken, { kind: "join", bindingId: "b", ackId: "ack-b" });
  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  await settle();
  expect(ended).toBe(false);
  expect(hook.disposed).toBe(false);

  world.resume(keyToken, { kind: "emit", event: event("e1") });
  await vi.waitFor(() => expect(world.fanOut).toHaveBeenCalled());
  expect(world.fanOut).toHaveBeenCalledWith({ bindingIds: ["b"], event: event("e1") });

  world.resume(keyToken, { kind: "leave", bindingId: "b" });
  await run;
  expect(hook.disposed).toBe(true);
  expect(world.owners.has(keyToken)).toBe(false);
});

it("drops the members whose owner is gone and ends when none remain", async () => {
  world.fanOut.mockResolvedValueOnce(["a"]).mockResolvedValueOnce(["b"]);
  const run = keyRun("a", "ack-a");
  await watching(keyToken);
  const hook = world.owners.get(keyToken)!;
  world.resume(keyToken, { kind: "join", bindingId: "b", ackId: "ack-b" });
  world.resume(keyToken, { kind: "emit", event: event("e1") });
  await vi.waitFor(() => expect(world.fanOut).toHaveBeenCalledTimes(1));
  world.resume(keyToken, { kind: "emit", event: event("e2") });
  await run;

  expect(world.fanOut.mock.calls.map(([input]) => input)).toEqual([
    { bindingIds: ["a", "b"], event: event("e1") },
    { bindingIds: ["b"], event: event("e2") },
  ]);
  expect(hook.disposed).toBe(true);
  expect(world.owners.has(keyToken)).toBe(false);
});

it("never acknowledges a join already queued behind the leave of the last member", async () => {
  const run = keyRun("a", "ack-a");
  let ended = false;
  void run.then(() => (ended = true));
  await watching(keyToken);
  await vi.waitFor(() => expect(world.acknowledge).toHaveBeenCalledWith("ack-a"));
  const hook = world.owners.get(keyToken)!;

  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  world.resume(keyToken, { kind: "join", bindingId: "b", ackId: "ack-b" });
  await run;

  expect(ended).toBe(true);
  expect(hook.disposed).toBe(true);
  expect(world.owners.has(keyToken)).toBe(false);
  expect(world.acknowledge).not.toHaveBeenCalledWith("ack-b");
  expect(world.acknowledge.mock.calls).toEqual([["ack-a"]]);
  expect(world.fanOut).not.toHaveBeenCalled();
});

it("hands its first subscription to the run that already holds the key, without acknowledging", async () => {
  const first = keyRun("a", "ack-a");
  await watching(keyToken);
  await vi.waitFor(() => expect(world.acknowledge).toHaveBeenCalledWith("ack-a"));
  const holderHookId = world.owners.get(keyToken)!.id;
  world.acknowledge.mockClear();

  await keyRun("b", "ack-b");
  expect(world.forward).toHaveBeenCalledExactlyOnceWith({
    source,
    key,
    bindingId: "b",
    ackId: "ack-b",
    to: holderHookId,
  });
  expect(world.acknowledge).not.toHaveBeenCalled();
  expect(world.fanOut).not.toHaveBeenCalled();
  expect(world.owners.get(keyToken)!.id).toBe(holderHookId);

  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  await first;
});

it("dispatches a delivery in its own workflow", async () => {
  const input = { binding, serializedContext, event: event("a") };
  await subscriptionDeliveryWorkflow(input);
  expect(world.dispatch).toHaveBeenCalledExactlyOnceWith(input);
});

it("lets a failed delivery fail its own run without touching the owner's hook", async () => {
  const run = subscriptionWorkflow({ binding, serializedContext });
  await vi.waitFor(() => expect(world.join).toHaveBeenCalled());
  const live = world.owners.get(ownerToken);
  world.dispatch.mockRejectedValueOnce(new Error("callback failed"));
  const input = { binding, serializedContext, event: event("a") };
  await expect(subscriptionDeliveryWorkflow(input)).rejects.toThrow("callback failed");
  expect(world.owners.get(ownerToken)).toBe(live);

  world.resume(ownerToken, { kind: "retire" });
  await run;
});

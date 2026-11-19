import { beforeEach, expect, it, vi } from "vitest";

import {
  channelKeyHookToken,
  channelSubscriptionHookToken,
  type ChannelSubscriptionBinding,
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
  const calls: string[] = [];
  return {
    owners,
    calls,
    hooks: [] as FakeHook<unknown>[],
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
      owners.get(token)!.push(value);
    },
    sleep() {
      return new Promise<void>((resolve) => (expire = resolve));
    },
    expire: () => expire?.(),
    announce: vi.fn(async (_binding: unknown) => {}),
    close: vi.fn(async (_input: unknown) => {}),
    dispatch: vi.fn(async (_input: unknown) => {}),
    fanOut: vi.fn(async (_input: unknown) => {}),
    join: vi.fn(async (_binding: unknown) => {}),
    joinExisting: vi.fn(async (_input: unknown) => {}),
    leave: vi.fn(async (_binding: unknown) => {}),
    publishedOwners: [] as string[],
    start: vi.fn(async (_input: unknown) => {}),
  };
});

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: world.createHook,
  sleep: world.sleep,
}));
vi.mock("./steps.js", () => ({
  announceChannelSubscriptionStep: async (binding: unknown) => {
    world.calls.push("announce");
    await world.announce(binding);
  },
  closeChannelSubscriptionStep: async (input: unknown) => {
    world.calls.push("close");
    await world.close(input);
  },
  dispatchChannelSubscriptionStep: world.dispatch,
  fanOutChannelEventStep: world.fanOut,
  joinChannelKeyStep: async (binding: unknown) => {
    world.calls.push("join");
    await world.join(binding);
  },
  joinExistingChannelKeyStep: world.joinExisting,
  leaveChannelKeyStep: async (binding: unknown) => {
    world.calls.push("leave");
    await world.leave(binding);
  },
  publishChannelSubscriptionOwnerStep: async (runId: string) => {
    world.publishedOwners.push(runId);
  },
  startChannelSubscriptionDeliveryStep: world.start,
}));

const {
  channelSubscriptionWorkflow,
  channelSubscriptionKeyWorkflow,
  channelSubscriptionDeliveryWorkflow,
} = await import("./workflow.js");

const binding: ChannelSubscriptionBinding = {
  id: "binding-1",
  channelName: "github",
  key: "vercel/eve#7",
  input: { pull: 7 },
  sessionId: "session-1",
  executionPrincipal: "principal-1",
  auth: null,
  ttlMs: null,
};
const ownerToken = channelSubscriptionHookToken(binding.id);
const keyToken = channelKeyHookToken(binding.channelName, binding.key);
const serializedContext = {};
const event = (id: string) => ({ id, data: { id } });

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  world.owners.clear();
  world.hooks.length = 0;
  world.calls.length = 0;
  world.publishedOwners.length = 0;
  for (const fn of [
    world.announce,
    world.close,
    world.dispatch,
    world.fanOut,
    world.join,
    world.joinExisting,
    world.leave,
    world.start,
  ])
    fn.mockClear();
});

it("joins its key before announcing, then forwards a delivery to the delivery step", async () => {
  const run = channelSubscriptionWorkflow({ binding, serializedContext });
  await settle();
  expect(world.calls).toEqual(["join", "announce"]);
  expect(world.join).toHaveBeenCalledWith(binding);
  expect(world.announce).toHaveBeenCalledWith(binding);

  world.resume(ownerToken, { kind: "delivery", event: event("a") });
  await settle();
  expect(world.start).toHaveBeenCalledTimes(1);
  expect(world.start).toHaveBeenCalledWith({ binding, serializedContext, event: event("a") });

  world.resume(ownerToken, { kind: "retire" });
  await run;
});

it("leaves its key, then closes, then returns when retired", async () => {
  const run = channelSubscriptionWorkflow({ binding, serializedContext });
  await settle();
  world.resume(ownerToken, { kind: "retire" });
  await run;

  expect(world.calls).toEqual(["join", "announce", "leave", "close"]);
  expect(world.leave).toHaveBeenCalledWith(binding);
  expect(world.close).toHaveBeenCalledWith({ binding, serializedContext });
  expect(world.start).not.toHaveBeenCalled();
});

it("leaves its key and closes when its time to live runs out", async () => {
  const run = channelSubscriptionWorkflow({
    binding: { ...binding, ttlMs: 60_000 },
    serializedContext,
  });
  await settle();
  world.expire();
  await run;

  expect(world.calls).toEqual(["join", "announce", "leave", "close"]);
  expect(world.start).not.toHaveBeenCalled();
});

it("points a second start of the same subscription at the run that owns it, without joining", async () => {
  const first = channelSubscriptionWorkflow({ binding, serializedContext });
  await settle();
  const ownerHookId = world.owners.get(ownerToken)!.id;
  world.calls.length = 0;
  world.join.mockClear();

  await channelSubscriptionWorkflow({ binding, serializedContext });
  expect(world.publishedOwners).toEqual([ownerHookId]);
  expect(world.join).not.toHaveBeenCalled();
  expect(world.calls).toEqual([]);

  world.resume(ownerToken, { kind: "retire" });
  await first;
});

it("fans each event out to every member once and ignores a repeated event id", async () => {
  const run = channelSubscriptionKeyWorkflow({
    channelName: binding.channelName,
    key: binding.key,
    first: "a",
  });
  await settle();
  world.resume(keyToken, { kind: "join", bindingId: "b" });
  world.resume(keyToken, { kind: "emit", event: event("e1") });
  world.resume(keyToken, { kind: "emit", event: event("e1") });
  await settle();

  expect(world.fanOut).toHaveBeenCalledTimes(1);
  expect(world.fanOut).toHaveBeenCalledWith({ bindingIds: ["a", "b"], event: event("e1") });

  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  world.resume(keyToken, { kind: "leave", bindingId: "b" });
  await run;
});

it("sends later events to a member that joined after the first", async () => {
  const run = channelSubscriptionKeyWorkflow({
    channelName: binding.channelName,
    key: binding.key,
    first: "a",
  });
  await settle();
  world.resume(keyToken, { kind: "emit", event: event("e1") });
  await settle();
  world.resume(keyToken, { kind: "join", bindingId: "b" });
  world.resume(keyToken, { kind: "emit", event: event("e2") });
  await settle();

  expect(world.fanOut.mock.calls.map(([input]) => input)).toEqual([
    { bindingIds: ["a"], event: event("e1") },
    { bindingIds: ["a", "b"], event: event("e2") },
  ]);

  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  world.resume(keyToken, { kind: "leave", bindingId: "b" });
  await run;
});

it("keeps running when a member other than the last leaves, and ends when the last one does", async () => {
  const run = channelSubscriptionKeyWorkflow({
    channelName: binding.channelName,
    key: binding.key,
    first: "a",
  });
  let ended = false;
  void run.then(() => (ended = true));
  await settle();
  const hook = world.owners.get(keyToken)!;

  world.resume(keyToken, { kind: "join", bindingId: "b" });
  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  await settle();
  expect(ended).toBe(false);
  expect(hook.disposed).toBe(false);

  world.resume(keyToken, { kind: "emit", event: event("e1") });
  await settle();
  expect(world.fanOut).toHaveBeenCalledWith({ bindingIds: ["b"], event: event("e1") });

  world.resume(keyToken, { kind: "leave", bindingId: "b" });
  await run;
  expect(hook.disposed).toBe(true);
  expect(world.owners.has(keyToken)).toBe(false);
});

it("joins the key workflow that already runs and returns when its hook conflicts", async () => {
  const first = channelSubscriptionKeyWorkflow({
    channelName: binding.channelName,
    key: binding.key,
    first: "a",
  });
  await settle();

  await channelSubscriptionKeyWorkflow({
    channelName: binding.channelName,
    key: binding.key,
    first: "b",
  });
  expect(world.joinExisting).toHaveBeenCalledWith({
    channelName: binding.channelName,
    key: binding.key,
    bindingId: "b",
  });
  expect(world.fanOut).not.toHaveBeenCalled();

  world.resume(keyToken, { kind: "leave", bindingId: "a" });
  await first;
});

it("dispatches a delivery in its own workflow", async () => {
  const input = { binding, serializedContext, event: event("a") };
  await channelSubscriptionDeliveryWorkflow(input);
  expect(world.dispatch).toHaveBeenCalledWith(input);
});

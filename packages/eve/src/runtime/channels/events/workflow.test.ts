import { beforeEach, expect, it, vi } from "vitest";

import { channelEventHookToken, type ChannelEventBinding } from "./state.js";

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
    announced: vi.fn(async (_binding: unknown) => {}),
    followed: [] as string[],
    started: vi.fn(async (_input: unknown) => {}),
    dispatch: vi.fn(async (_input: unknown) => {}),
  };
});

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: world.createHook,
  sleep: world.sleep,
}));
vi.mock("#runtime/channels/events/steps.js", () => ({
  announceChannelEventStep: world.announced,
  dispatchChannelEventStep: world.dispatch,
  publishChannelEventOwnerStep: async (runId: string) => {
    world.followed.push(runId);
  },
  startChannelEventDeliveryStep: world.started,
}));

const { channelEventWorkflow, channelEventDeliveryWorkflow } = await import("./workflow.js");

const binding: ChannelEventBinding = {
  id: "binding-1",
  channelName: "github",
  event: "checks_finished",
  arguments: { owner: "vercel", pull: 7, repo: "eve" },
  sessionId: "session-1",
  auth: null,
  executionPrincipal: "principal-1",
  ttlMs: null,
};
const token = channelEventHookToken(binding.id);
const serializedContext = {};
const delivery = (id: string) => ({ id, message: `message ${id}` });

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  world.owners.clear();
  world.followed.length = 0;
  world.announced.mockClear();
  world.started.mockClear();
  world.dispatch.mockClear();
});

it("announces the subscription, then starts one delivery per distinct occurrence", async () => {
  const run = channelEventWorkflow({ binding, serializedContext });
  await settle();
  expect(world.announced).toHaveBeenCalledWith(binding);

  world.resume(token, { kind: "delivery", delivery: delivery("a") });
  world.resume(token, { kind: "delivery", delivery: delivery("a") });
  world.resume(token, { kind: "delivery", delivery: delivery("b") });
  world.resume(token, { kind: "retire" });
  await run;

  expect(
    world.started.mock.calls.map(([input]) => (input as { delivery: { id: string } }).delivery.id),
  ).toEqual(["a", "b"]);
  expect(world.started).toHaveBeenCalledWith({
    binding,
    serializedContext,
    delivery: delivery("a"),
  });
});

it("ends when its time to live runs out", async () => {
  const run = channelEventWorkflow({ binding: { ...binding, ttlMs: 60_000 }, serializedContext });
  await settle();
  world.expire();
  await run;
  expect(world.started).not.toHaveBeenCalled();
});

it("points a second start for the same subscription at the run that already owns it", async () => {
  const first = channelEventWorkflow({ binding, serializedContext });
  await settle();
  const ownerHookId = world.owners.get(token)!.id;
  await channelEventWorkflow({ binding, serializedContext });
  expect(world.followed).toEqual([ownerHookId]);
  expect(world.announced).toHaveBeenCalledTimes(1);

  world.resume(token, { kind: "retire" });
  await first;
});

it("dispatches a delivery in its own workflow", async () => {
  const input = { binding, serializedContext, delivery: delivery("a") };
  await channelEventDeliveryWorkflow(input);
  expect(world.dispatch).toHaveBeenCalledWith(input);
});

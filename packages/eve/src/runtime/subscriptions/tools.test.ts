import { beforeEach, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { serializeInputSchema } from "#tools/schema.js";
import { channelEventKey, channelSubscriptionId } from "./id.js";
import type { OpenedSubscription, SubscriptionBinding } from "./state.js";

const host = vi.hoisted(() => ({
  bindings: new Map<string, SubscriptionBinding>(),
  start: vi.fn(),
  retire: vi.fn(),
  find: undefined as undefined | ((id: string) => Promise<unknown>),
}));
vi.mock("#execution/hosts.js", () => ({
  installedDurableHost: () => ({
    subscriptions: {
      start: host.start,
      retire: host.retire,
      async find(id: string) {
        if (host.find !== undefined) return host.find(id);
        const binding = host.bindings.get(id);
        return binding && { binding, opened: undefined };
      },
    },
  }),
}));
vi.mock("#runtime/sessions/runtime-context-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#runtime/sessions/runtime-context-keys.js")>()),
  requireCompiledBundle: () => ({ bundle: true }),
}));

const { channelSubscriptionTools } = await import("./tools.js");

const githubSchema = {
  type: "object",
  additionalProperties: false,
  required: ["owner", "pull"],
  properties: { owner: { type: "string" }, pull: { type: "integer" } },
};
const slackSchema = {
  type: "object",
  additionalProperties: false,
  required: ["thread"],
  properties: { thread: { type: "string" } },
};

const channelsOf = (...entries: readonly [string, unknown][]) =>
  entries.map(([name, subscriptions]) => ({ name, definition: { subscriptions } })) as never;
const checksFinished = {
  description: "Watch a pull request until its checks finish.",
  inputSchema: githubSchema,
};
const github = { checks_finished: checksFinished };
const channels = channelsOf(["github", github]);

const authOf = (id: string) =>
  ({
    attributes: {},
    authenticator: "hub",
    issuer: "hub",
    principalId: id,
    principalType: "user",
  }) satisfies SessionAuthContext;

function inSession<T>(sessionId: string, auth: SessionAuthContext, run: () => Promise<T>) {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionIdKey, sessionId);
  ctx.setVirtualContext(AuthKey, auth);
  ctx.setVirtualContext(SessionAgentKey, { compiled: { bundle: true } } as never);
  return contextStorage.run(ctx, run);
}

const call = (name: string, input: unknown) => {
  const tool = channelSubscriptionTools(channels)![name] as unknown as {
    execute(input: unknown, options: { abortSignal?: AbortSignal }): Promise<unknown>;
  };
  return tool.execute(input, {});
};

const githubInput = { owner: "vercel", pull: 7 };
const subscribeInput = {
  subscription: {
    channel: "github",
    event: "checks_finished",
    input: { owner: "vercel", pull: 7 },
  },
  ttlMs: 120_000,
};
const subscribeAs = (sessionId: string, user: string, input: unknown = subscribeInput) =>
  inSession(sessionId, authOf(user), () => call("subscribe", input));

const opened = (binding: SubscriptionBinding): OpenedSubscription => ({
  key: (binding.source as { key: string }).key,
  expiresAt: null,
});

beforeEach(() => {
  host.bindings.clear();
  host.find = undefined;
  host.start.mockReset();
  host.retire.mockReset();
  host.start.mockImplementation(async (binding: SubscriptionBinding) => {
    host.bindings.set(binding.id, binding);
    return opened(binding);
  });
  host.retire.mockResolvedValue(true);
});

it("offers subscribe, get and stop, or nothing when no channel has subscriptions", () => {
  expect(Object.keys(channelSubscriptionTools(channels)!)).toEqual([
    "subscribe",
    "get_subscription",
    "stop_subscription",
  ]);
  expect(channelSubscriptionTools([{ name: "slack", definition: {} }] as never)).toBeNull();
});

it("gives the subscribe schema one anyOf entry per declared event", () => {
  const two = channelsOf(
    ["github", github],
    ["slack", { thread_replied: { description: "Watch a thread.", inputSchema: slackSchema } }],
    ["email", undefined],
    ["empty", {}],
  );
  const tool = channelSubscriptionTools(two)!.subscribe as unknown as { inputSchema: never };
  const parsed = serializeInputSchema(tool.inputSchema) as unknown as {
    properties: { subscription: { anyOf: { properties: Record<string, unknown> }[] } };
  };
  const entries = parsed.properties.subscription.anyOf;
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.properties.channel)).toEqual([
    { const: "github" },
    { const: "slack" },
  ]);
  expect(entries.map((entry) => entry.properties.event)).toEqual([
    { const: "checks_finished" },
    { const: "thread_replied" },
  ]);
  expect(entries[0]!.properties.input).toEqual(githubSchema);
  expect(entries[1]!.properties.input).toEqual(slackSchema);
});

it("starts a binding carrying the event, the derived key, ttl and principal", async () => {
  const result = await subscribeAs("s1", "rui");

  const key = channelEventKey("checks_finished", { owner: "vercel", pull: 7 });
  const executionPrincipal = (host.start.mock.calls[0]![0] as SubscriptionBinding)
    .executionPrincipal;
  const id = channelSubscriptionId({
    channelName: "github",
    key,
    sessionId: "s1",
    executionPrincipal,
  });
  expect(result).toMatchObject({
    id,
    channel: "github",
    event: "checks_finished",
    input: { owner: "vercel", pull: 7 },
    status: "active",
    expiresAt: null,
  });
  expect(host.start.mock.calls[0]![0]).toMatchObject({
    id,
    source: {
      kind: "channel",
      name: "github",
      event: "checks_finished",
      key,
      input: { owner: "vercel", pull: 7 },
      ttlMs: 120_000,
    },
    sessionId: "s1",
    auth: authOf("rui"),
  });
  expect(executionPrincipal).toEqual(expect.any(String));
});

it("validates the input and derives the key emit derives, ignoring string case", async () => {
  await subscribeAs("s1", "rui", {
    subscription: {
      channel: "github",
      event: "checks_finished",
      input: { owner: "Vercel", pull: 7 },
    },
    ttlMs: null,
  });
  await subscribeAs("s1", "rui");

  const [upper, lower] = host.start.mock.calls.map(
    ([binding]) => binding as SubscriptionBinding & { source: { key: string; input: unknown } },
  );
  expect(upper!.source.input).toEqual({ owner: "Vercel", pull: 7 });
  expect(upper!.source.key).toBe(lower!.source.key);
  expect(upper!.source.key).toBe(channelEventKey("checks_finished", { owner: "vercel", pull: 7 }));
  expect(upper!.id).toBe(lower!.id);

  await expect(
    subscribeAs("s1", "rui", {
      subscription: { channel: "github", event: "checks_finished", input: { owner: "v" } },
      ttlMs: null,
    }),
  ).rejects.toThrow("does not match the event's schema");
  expect(host.start).toHaveBeenCalledTimes(2);
});

it("offers one anyOf branch per event of a channel and refuses an event it does not declare", async () => {
  const two = channelsOf([
    "github",
    {
      checks_finished: checksFinished,
      pull_merged: { description: "Watch a merge.", inputSchema: githubSchema },
    },
  ]);
  const tools = channelSubscriptionTools(two)!;
  const subscribeTool = tools.subscribe as unknown as {
    description: string;
    inputSchema: never;
    execute(input: unknown, options: object): Promise<unknown>;
  };
  const parsed = serializeInputSchema(subscribeTool.inputSchema) as unknown as {
    properties: { subscription: { anyOf: { properties: Record<string, unknown> }[] } };
  };
  expect(parsed.properties.subscription.anyOf.map((entry) => entry.properties.event)).toEqual([
    { const: "checks_finished" },
    { const: "pull_merged" },
  ]);
  expect(subscribeTool.description).toContain(
    "github.checks_finished: Watch a pull request until its checks finish.",
  );
  expect(subscribeTool.description).toContain("github.pull_merged: Watch a merge.");

  await expect(
    inSession("s1", authOf("rui"), () =>
      subscribeTool.execute(
        {
          subscription: { channel: "github", event: "pull_closed", input: githubInput },
          ttlMs: null,
        },
        {},
      ),
    ),
  ).rejects.toThrow('Channel "github" offers no subscription to "pull_closed".');
  expect(host.start).not.toHaveBeenCalled();
});

it("refuses a channel that offers no subscriptions", async () => {
  await expect(
    subscribeAs("s1", "rui", {
      subscription: { channel: "slack", event: "checks_finished", input: {} },
      ttlMs: null,
    }),
  ).rejects.toThrow('Channel "slack" offers no subscription to "checks_finished".');
  expect(host.start).not.toHaveBeenCalled();
});

it("gives two sessions different ids for one key and one session the same id twice", async () => {
  const idOf = async (sessionId: string) =>
    ((await subscribeAs(sessionId, "rui")) as { id: string }).id;

  const first = await idOf("s1");
  expect(await idOf("s1")).toBe(first);
  expect(await idOf("s2")).not.toBe(first);
});

it("lets only the principal that subscribed get or stop a subscription", async () => {
  const { id } = (await subscribeAs("s1", "rui")) as { id: string };

  await expect(
    inSession("s9", authOf("someone-else"), () => call("get_subscription", { id })),
  ).rejects.toThrow("Unknown subscription for this caller.");
  await expect(
    inSession("s9", authOf("someone-else"), () => call("stop_subscription", { id })),
  ).rejects.toThrow("Unknown subscription for this caller.");
  expect(host.retire).not.toHaveBeenCalled();

  await expect(
    inSession("s2", authOf("rui"), () => call("get_subscription", { id })),
  ).resolves.toMatchObject({ id, status: "pending" });
  await expect(
    inSession("s2", authOf("rui"), () => call("stop_subscription", { id })),
  ).resolves.toEqual({ id, status: "stopping" });
  expect(host.retire).toHaveBeenCalledWith(id);
});

it("reports an unknown id and a subscription that already ended", async () => {
  await expect(
    inSession("s1", authOf("rui"), () => call("get_subscription", { id: "nope" })),
  ).rejects.toThrow("Unknown subscription for this caller.");

  const { id } = (await subscribeAs("s1", "rui")) as { id: string };
  host.retire.mockResolvedValue(false);
  await expect(
    inSession("s1", authOf("rui"), () => call("stop_subscription", { id })),
  ).rejects.toThrow("Unknown subscription for this caller.");
});

it("reports an opened subscription as active with its expiry", async () => {
  const { id } = (await subscribeAs("s1", "rui")) as { id: string };
  const binding = host.bindings.get(id)!;
  host.find = async () => ({
    binding,
    opened: { key: "k", expiresAt: "2030-01-01T00:00:00.000Z" },
  });
  await expect(
    inSession("s1", authOf("rui"), () => call("get_subscription", { id })),
  ).resolves.toEqual({
    id,
    channel: "github",
    event: "checks_finished",
    input: { owner: "vercel", pull: 7 },
    status: "active",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
});

it("does not expose a connection subscription held by the same principal", async () => {
  const { id } = (await subscribeAs("s1", "rui")) as { id: string };
  const binding = host.bindings.get(id)!;
  host.bindings.set(id, {
    ...binding,
    source: {
      kind: "connection",
      name: "issues",
      instanceId: undefined,
      connector: "linear",
      principalKey: "p",
      request: {},
    } as never,
  });
  await expect(
    inSession("s1", authOf("rui"), () => call("get_subscription", { id })),
  ).rejects.toThrow("Unknown subscription for this caller.");
  await expect(
    inSession("s1", authOf("rui"), () => call("stop_subscription", { id })),
  ).rejects.toThrow("Unknown subscription for this caller.");
  expect(host.retire).not.toHaveBeenCalled();
});

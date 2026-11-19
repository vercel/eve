import { beforeEach, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { serializeInputSchema } from "#tools/schema.js";
import { channelSubscriptionId } from "./id.js";
import type { ChannelSubscriptionBinding, ChannelSubscriptionStatus } from "./state.js";

const host = vi.hoisted(() => ({
  bindings: new Map<string, ChannelSubscriptionBinding>(),
  start: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("#execution/hosts.js", () => ({
  installedDurableHost: () => ({
    channelSubscriptions: {
      start: host.start,
      retire: host.retire,
      async find(id: string) {
        const binding = host.bindings.get(id);
        return binding && { binding, status: undefined };
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

const onSubscribe = vi.fn();
const channelsOf = (...entries: readonly [string, unknown][]) =>
  entries.map(([name, subscriptions]) => ({ name, definition: { subscriptions } })) as never;
const github = {
  description: "Watch a pull request.",
  inputSchema: githubSchema,
  onSubscribe,
};
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

const subscribeInput = {
  subscription: { channel: "github", input: { owner: "vercel", pull: 7 } },
  ttlMs: 120_000,
};
const subscribeAs = (sessionId: string, user: string, input: unknown = subscribeInput) =>
  inSession(sessionId, authOf(user), () => call("subscribe", input));

const status = (binding: ChannelSubscriptionBinding): ChannelSubscriptionStatus => ({
  id: binding.id,
  channel: binding.channelName,
  input: binding.input,
  status: "active",
  expiresAt: null,
});

beforeEach(() => {
  host.bindings.clear();
  host.start.mockReset();
  host.retire.mockReset();
  onSubscribe.mockReset();
  onSubscribe.mockResolvedValue({ key: "vercel/eve#7:checks_finished" });
  host.start.mockImplementation(async (binding: ChannelSubscriptionBinding) => {
    host.bindings.set(binding.id, binding);
    return status(binding);
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

it("gives the subscribe schema one anyOf entry per channel with subscriptions", () => {
  const two = channelsOf(
    ["github", github],
    ["slack", { ...github, inputSchema: slackSchema }],
    ["email", undefined],
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
  expect(entries[0]!.properties.input).toEqual(githubSchema);
  expect(entries[1]!.properties.input).toEqual(slackSchema);
});

it("runs onSubscribe as the caller and starts a binding carrying key, ttl and principal", async () => {
  const result = await subscribeAs("s1", "rui");

  expect(onSubscribe).toHaveBeenCalledWith({
    auth: authOf("rui"),
    sessionId: "s1",
    input: { owner: "vercel", pull: 7 },
  });
  const executionPrincipal = (host.start.mock.calls[0]![0] as ChannelSubscriptionBinding)
    .executionPrincipal;
  const id = channelSubscriptionId({
    channelName: "github",
    key: "vercel/eve#7:checks_finished",
    sessionId: "s1",
    executionPrincipal,
  });
  expect(result).toMatchObject({ id, channel: "github", status: "active" });
  expect(host.start.mock.calls[0]![0]).toMatchObject({
    id,
    channelName: "github",
    key: "vercel/eve#7:checks_finished",
    input: { owner: "vercel", pull: 7 },
    sessionId: "s1",
    auth: authOf("rui"),
    ttlMs: 120_000,
  });
  expect(executionPrincipal).toEqual(expect.any(String));
});

it("rejects input that does not match the channel's schema before onSubscribe runs", async () => {
  await expect(
    subscribeAs("s1", "rui", {
      subscription: { channel: "github", input: { owner: "v" } },
      ttlMs: null,
    }),
  ).rejects.toThrow("does not match the channel's schema");
  expect(onSubscribe).not.toHaveBeenCalled();
  expect(host.start).not.toHaveBeenCalled();
});

it("refuses a channel that offers no subscriptions", async () => {
  await expect(
    subscribeAs("s1", "rui", {
      subscription: { channel: "slack", input: {} },
      ttlMs: null,
    }),
  ).rejects.toThrow('Channel "slack" offers no subscriptions.');
  expect(onSubscribe).not.toHaveBeenCalled();
});

it("propagates the error onSubscribe throws and starts nothing", async () => {
  onSubscribe.mockRejectedValue(new Error("not allowed on this repository"));
  await expect(subscribeAs("s1", "rui")).rejects.toThrow("not allowed on this repository");
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

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { serializeInputSchema } from "#tools/schema.js";
import { withSubscriptionCatalog } from "#shared/channel-subscriptions.js";
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

const { channelSubscribeEntry, offeredSubscriptions, subscriptionManagementEntries } =
  await import("./tools.js");

const channelsOf = (...entries: readonly [string, unknown][]) =>
  entries.map(([name, onEvent]) => ({ name, definition: { onEvent } })) as never;
const channels = channelsOf(["github", () => null]);

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

const gate = {
  approval: vi.fn((_action: string) => undefined as undefined),
  run: vi.fn(async (_connection: string, action: string) => ({ via: action })),
};

const call = (name: string, input: unknown) => {
  const tool =
    name === "eve__subscribe"
      ? channelSubscribeEntry(offeredSubscriptions(channels))
      : subscriptionManagementEntries(gate).find((entry) => entry.name === name)!;
  return tool.execute!(input, { messages: [], toolCallId: "call-1" });
};

const subscribeInput = {
  subscription: {
    source: "github",
    event: "checks_finished",
    input: { owner: "vercel", pull: 7 },
  },
  ttlMs: 120_000,
};
const subscribeAs = (sessionId: string, user: string, input: unknown = subscribeInput) =>
  inSession(sessionId, authOf(user), () => call("eve__subscribe", input));

const opened = (binding: SubscriptionBinding): OpenedSubscription => ({
  key: (binding.source as { key: string }).key,
  expiresAt: null,
});

beforeEach(() => {
  host.bindings.clear();
  host.find = undefined;
  host.start.mockReset();
  host.retire.mockReset();
  gate.approval.mockClear();
  gate.run.mockClear();
  host.start.mockImplementation(async (binding: SubscriptionBinding) => {
    host.bindings.set(binding.id, binding);
    return opened(binding);
  });
  host.retire.mockResolvedValue(true);
});

it("offers each channel with subscriptions once", () => {
  const two = channelsOf(["github", () => null], ["github", () => null], ["email", undefined]);
  expect(offeredSubscriptions(two).map(({ channelName }) => channelName)).toEqual(["github"]);
  expect(offeredSubscriptions([{ name: "slack", definition: {} }] as never)).toEqual([]);
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
    source: "github",
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

it("derives the key emit derives from the input, comparing strings exactly", async () => {
  await subscribeAs("s1", "rui", {
    subscription: {
      source: "github",
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
  expect(upper!.source.key).toBe(channelEventKey("checks_finished", { owner: "Vercel", pull: 7 }));
  expect(lower!.source.key).toBe(channelEventKey("checks_finished", { owner: "vercel", pull: 7 }));
  expect(upper!.source.key).not.toBe(lower!.source.key);
  expect(upper!.id).not.toBe(lower!.id);
});

it("accepts any event name and any input object, leaving the decision to onEvent", async () => {
  await expect(
    subscribeAs("s1", "rui", {
      subscription: { source: "github", event: "pushed", input: {} },
      ttlMs: null,
    }),
  ).resolves.toMatchObject({ event: "pushed", input: {}, status: "active" });
  expect(host.start).toHaveBeenCalledTimes(1);
});

const catalogued = channelsOf([
  "github",
  withSubscriptionCatalog(() => null, {
    description: "GitHub events.",
    events: ["check_suite.completed"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "repo"],
      properties: {
        owner: { type: "string", pattern: "^[^A-Z]+$" },
        repo: { type: "string", pattern: "^[^A-Z]+$" },
      },
    },
  }),
]);
const subscribeCatalogued = (event: string, input: unknown) =>
  inSession("s1", authOf("rui"), () =>
    channelSubscribeEntry(offeredSubscriptions(catalogued)).execute!(
      { subscription: { source: "github", event, input }, ttlMs: null },
      { messages: [], toolCallId: "call-1" },
    ),
  );

it("puts a published event list and scope in the tool schema, and none for a channel that publishes nothing", () => {
  const schemaOf = (offered: ReturnType<typeof offeredSubscriptions>) =>
    JSON.stringify(serializeInputSchema(channelSubscribeEntry(offered).inputSchema as never));
  expect(schemaOf(offeredSubscriptions(catalogued))).toContain("check_suite.completed");
  expect(schemaOf(offeredSubscriptions(catalogued))).toContain("^[^A-Z]+$");
  expect(schemaOf(offeredSubscriptions(channels))).not.toContain("enum");
});

it("refuses an event name a published catalog does not list, and a scope its schema rejects", async () => {
  await expect(subscribeCatalogued("pushed", { owner: "vercel", repo: "eve" })).rejects.toThrow(
    'Channel "github" emits no event named "pushed".',
  );
  await expect(
    subscribeCatalogued("check_suite.completed", { owner: "Vercel", repo: "eve" }),
  ).rejects.toThrow("does not match the channel's schema");
  expect(host.start).not.toHaveBeenCalled();

  await expect(
    subscribeCatalogued("check_suite.completed", { owner: "vercel", repo: "eve" }),
  ).resolves.toMatchObject({ event: "check_suite.completed", status: "active" });
});

it("refuses a channel that offers no subscriptions", async () => {
  await expect(
    subscribeAs("s1", "rui", {
      subscription: { source: "slack", event: "checks_finished", input: {} },
      ttlMs: null,
    }),
  ).rejects.toThrow('Channel "slack" offers no subscriptions.');
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
    inSession("s9", authOf("someone-else"), () => call("eve__subscription_get", { id })),
  ).rejects.toThrow("Unknown subscription for this caller.");
  await expect(
    inSession("s9", authOf("someone-else"), () => call("eve__subscription_stop", { id })),
  ).rejects.toThrow("Unknown subscription for this caller.");
  expect(host.retire).not.toHaveBeenCalled();

  await expect(
    inSession("s2", authOf("rui"), () => call("eve__subscription_get", { id })),
  ).resolves.toMatchObject({ id, status: "pending" });
  await expect(
    inSession("s2", authOf("rui"), () => call("eve__subscription_stop", { id })),
  ).resolves.toEqual({ id, status: "stopping" });
  expect(host.retire).toHaveBeenCalledWith(id);
});

it("reports an unknown id and a subscription that already ended", async () => {
  await expect(
    inSession("s1", authOf("rui"), () => call("eve__subscription_get", { id: "nope" })),
  ).rejects.toThrow("Unknown subscription for this caller.");

  const { id } = (await subscribeAs("s1", "rui")) as { id: string };
  host.retire.mockResolvedValue(false);
  await expect(
    inSession("s1", authOf("rui"), () => call("eve__subscription_stop", { id })),
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
    inSession("s1", authOf("rui"), () => call("eve__subscription_get", { id })),
  ).resolves.toEqual({
    id,
    source: "github",
    event: "checks_finished",
    input: { owner: "vercel", pull: 7 },
    status: "active",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
});

it("hands a connection subscription's get and stop to that connection's gate, with the subscription's id", async () => {
  const { id } = (await subscribeAs("s1", "rui")) as { id: string };
  host.bindings.set(id, {
    ...host.bindings.get(id)!,
    source: { kind: "connection", name: "issues", connector: "linear", principalKey: "p" } as never,
  });

  const get = await inSession("s1", authOf("rui"), () => call("eve__subscription_get", { id }));
  const stop = await inSession("s1", authOf("rui"), () => call("eve__subscription_stop", { id }));

  expect(get).toEqual({ via: "events_get_subscription" });
  expect(stop).toEqual({ via: "events_unsubscribe" });
  expect(gate.run).toHaveBeenCalledWith(
    "issues",
    "events_unsubscribe",
    { id },
    expect.objectContaining({ toolCallId: "call-1" }),
  );
  expect(host.retire).not.toHaveBeenCalled();
});

it("marks all three tools as framework tools only the root agent sees", () => {
  const entries = [
    channelSubscribeEntry(offeredSubscriptions(channels)),
    ...subscriptionManagementEntries(gate),
  ];
  expect(
    entries.map(({ name, frameworkTool, rootOnly }) => [name, frameworkTool, rootOnly]),
  ).toEqual([
    ["eve__subscribe", true, true],
    ["eve__subscription_get", true, true],
    ["eve__subscription_stop", true, true],
  ]);
});

it("asks the gate for each management tool's approval with the connection action it runs", () => {
  gate.approval.mockClear();
  subscriptionManagementEntries(gate);
  expect(gate.approval.mock.calls.map(([action]) => action)).toEqual([
    "events_get_subscription",
    "events_unsubscribe",
  ]);
});

describe("onSubscribe", () => {
  const subscribeWith = (onSubscribe: unknown, user = "rui") => {
    const offered = offeredSubscriptions([
      { name: "github", definition: { onEvent: () => null, onSubscribe } },
    ] as never);
    return inSession("s1", authOf(user), () =>
      channelSubscribeEntry(offered).execute!(subscribeInput, {
        messages: [],
        toolCallId: "call-1",
      }),
    );
  };

  it("runs before the subscription is held, as the caller, with the requested scope", async () => {
    const onSubscribe = vi.fn(async () => undefined);

    await subscribeWith(onSubscribe, "rui");

    expect(onSubscribe).toHaveBeenCalledExactlyOnceWith({
      auth: authOf("rui"),
      sessionId: "s1",
      subscription: {
        channelName: "github",
        event: "checks_finished",
        input: { owner: "vercel", pull: 7 },
      },
    });
    expect(host.start).toHaveBeenCalledTimes(1);
  });

  it("denies by throwing, and holds nothing", async () => {
    const deny = () => {
      throw new Error("Only vercel/eve may be watched.");
    };

    await expect(subscribeWith(deny)).rejects.toThrow("Only vercel/eve may be watched.");
    expect(host.start).not.toHaveBeenCalled();
  });

  it("subscribes to the narrower scope it returns", async () => {
    await subscribeWith(() => ({ input: { owner: "vercel" } }));

    expect(host.start.mock.calls[0]![0]).toMatchObject({
      source: {
        input: { owner: "vercel" },
        key: channelEventKey("checks_finished", { owner: "vercel" }),
      },
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "#shared/json.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { channelEventKey, channelSubscriptionId } from "./id.js";
import type { SubscribeInput } from "./tools.js";
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

const { offeredSubscriptions, stopSubscriptionEntry, subscribeToChannel } =
  await import("./tools.js");

const channelsOf = (...entries: readonly [string, unknown, unknown?][]) =>
  entries.map(([name, onEvent, events]) => ({
    name,
    definition: { onEvent, events },
  })) as never;
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

const stop = (id: string) =>
  stopSubscriptionEntry(gate).execute!({ id }, { messages: [], toolCallId: "call-1" });

const subscribeInput: SubscribeInput = {
  source: "github",
  event: "checks_finished",
  input: { owner: "vercel", pull: 7 },
  ttlMs: 120_000,
};
const subscribeAs = (sessionId: string, user: string, input: SubscribeInput = subscribeInput) =>
  inSession(sessionId, authOf(user), () =>
    subscribeToChannel(offeredSubscriptions(channels), input, undefined),
  );

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
    source: "github",
    event: "checks_finished",
    input: { owner: "Vercel", pull: 7 },
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

it("accepts any event name and any input object from a channel that declares no events, leaving the decision to onEvent", async () => {
  await expect(
    subscribeAs("s1", "rui", { source: "github", event: "pushed", input: {}, ttlMs: null }),
  ).resolves.toMatchObject({ event: "pushed", input: {}, status: "active" });
  expect(host.start).toHaveBeenCalledTimes(1);
});

const eventDefinitions = [
  {
    name: "check_suite.completed",
    description: "A check suite finished.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "repo"],
      properties: {
        owner: { type: "string", pattern: "^[^A-Z]+$" },
        repo: { type: "string", pattern: "^[^A-Z]+$" },
      },
    },
  },
  {
    name: "check_suite.requested",
    description: "A check suite was requested.",
    inputSchema: { type: "object" },
  },
  { name: "push", description: "A push.", inputSchema: { type: "object" } },
];
const declared = channelsOf(["github", () => null, eventDefinitions]);
const subscribeDeclared = (event: string, input: JsonObject) =>
  inSession("s1", authOf("rui"), () =>
    subscribeToChannel(
      offeredSubscriptions(declared),
      { source: "github", event, input, ttlMs: null },
      undefined,
    ),
  );

it("refuses an event the channel does not declare, naming the closest events and where to find them", async () => {
  const error = await subscribeDeclared("check_suite.complete", {
    owner: "vercel",
    repo: "eve",
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("Expected the subscribe to be refused.");
  expect(error.message).toContain('Channel "github" emits no event named "check_suite.complete".');
  expect(error.message).toContain("Closest events: ");
  expect(error.message).toContain("check_suite.completed");
  expect(error.message).toContain("eve__search");
  expect(error.message).toContain("subscriptions__github__");
  expect(host.start).not.toHaveBeenCalled();
});

it("refuses an input the event's schema rejects, and subscribes when it fits", async () => {
  await expect(
    subscribeDeclared("check_suite.completed", { owner: "Vercel", repo: "eve" }),
  ).rejects.toThrow('Subscription input does not match the schema of "check_suite.completed"');
  await expect(subscribeDeclared("check_suite.completed", { owner: "vercel" })).rejects.toThrow(
    'Subscription input does not match the schema of "check_suite.completed"',
  );
  expect(host.start).not.toHaveBeenCalled();

  await expect(
    subscribeDeclared("check_suite.completed", { owner: "vercel", repo: "eve" }),
  ).resolves.toMatchObject({ event: "check_suite.completed", status: "active" });
});

it("checks an input against the schema of the event named, not of another event", async () => {
  await expect(subscribeDeclared("push", { owner: "Vercel" })).resolves.toMatchObject({
    event: "push",
    input: { owner: "Vercel" },
  });
});

it("refuses a channel that offers no subscriptions", async () => {
  await expect(
    subscribeAs("s1", "rui", {
      source: "slack",
      event: "checks_finished",
      input: {},
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

it("lets only the principal that subscribed stop a subscription", async () => {
  const { id } = (await subscribeAs("s1", "rui")) as { id: string };

  await expect(inSession("s9", authOf("someone-else"), () => stop(id))).rejects.toThrow(
    "Unknown subscription for this caller.",
  );
  expect(host.retire).not.toHaveBeenCalled();

  await expect(inSession("s2", authOf("rui"), () => stop(id))).resolves.toEqual({
    id,
    status: "stopping",
  });
  expect(host.retire).toHaveBeenCalledWith(id);
});

it("reports an unknown id and a subscription that already ended", async () => {
  await expect(inSession("s1", authOf("rui"), () => stop("nope"))).rejects.toThrow(
    "Unknown subscription for this caller.",
  );

  const { id } = (await subscribeAs("s1", "rui")) as { id: string };
  host.retire.mockResolvedValue(false);
  await expect(inSession("s1", authOf("rui"), () => stop(id))).rejects.toThrow(
    "Unknown subscription for this caller.",
  );
});

it("reports an opened subscription as active with its expiry", async () => {
  host.start.mockImplementation(async (binding: SubscriptionBinding) => ({
    ...opened(binding),
    expiresAt: "2030-01-01T00:00:00.000Z",
  }));
  await expect(subscribeAs("s1", "rui")).resolves.toMatchObject({
    source: "github",
    event: "checks_finished",
    input: { owner: "vercel", pull: 7 },
    status: "active",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
});

it("reports a subscription the host has not opened yet as pending", async () => {
  host.start.mockResolvedValue(undefined);
  await expect(subscribeAs("s1", "rui")).resolves.toMatchObject({
    status: "pending",
    event: "checks_finished",
  });
});

it("hands a connection subscription's stop to that connection's gate, with the subscription's id", async () => {
  const { id } = (await subscribeAs("s1", "rui")) as { id: string };
  host.bindings.set(id, {
    ...host.bindings.get(id)!,
    source: { kind: "connection", name: "issues", connector: "linear", principalKey: "p" } as never,
  });

  const result = await inSession("s1", authOf("rui"), () => stop(id));

  expect(result).toEqual({ via: "events_unsubscribe" });
  expect(gate.run).toHaveBeenCalledWith(
    "issues",
    "events_unsubscribe",
    { id },
    expect.objectContaining({ toolCallId: "call-1" }),
  );
  expect(host.retire).not.toHaveBeenCalled();
});

it("marks the stop tool as a framework tool only the root agent sees", () => {
  const entry = stopSubscriptionEntry(gate);
  expect([entry.name, entry.frameworkTool, entry.rootOnly]).toEqual([
    "eve__subscription_stop",
    true,
    true,
  ]);
});

it("asks the gate for the stop tool's approval with the connection action it runs", () => {
  gate.approval.mockClear();
  stopSubscriptionEntry(gate);
  expect(gate.approval.mock.calls.map(([action]) => action)).toEqual(["events_unsubscribe"]);
});

describe("onSubscribe", () => {
  const subscribeWith = (onSubscribe: unknown, user = "rui") => {
    const offered = offeredSubscriptions([
      { name: "github", definition: { onEvent: () => null, onSubscribe } },
    ] as never);
    return inSession("s1", authOf(user), () =>
      subscribeToChannel(offered, subscribeInput, undefined),
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

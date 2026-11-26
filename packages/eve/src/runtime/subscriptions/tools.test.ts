import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "#shared/json.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ANONYMOUS_SESSION_AUTH_CONTEXT } from "#channel/principal-identity.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SteeredByKey } from "#context/keys.js";
import { withModelCall } from "#runtime/connections/identity-hold.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { channelEventKey, channelSubscriptionId } from "./keys.js";
import type { SubscribeInput } from "./tools.js";
import { defineJsonSchema } from "#tools/schema.js";
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

const checksFinished = [
  {
    name: "checks_finished",
    description: "Checks finished.",
    inputSchema: defineJsonSchema({ type: "object" }),
  },
];
const channelsOf = (...entries: readonly [string, unknown, unknown?][]) =>
  entries.map(([name, onEvent, events]) => ({
    name,
    definition: { onEvent, catalog: () => events ?? checksFinished },
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

function inSession<T>(sessionId: string, auth: SessionAuthContext | null, run: () => Promise<T>) {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionIdKey, sessionId);
  ctx.setVirtualContext(AuthKey, auth);
  ctx.setVirtualContext(SessionAgentKey, { compiled: { bundle: true } } as never);
  return contextStorage.run(ctx, run);
}

const gate = {
  approval: vi.fn(() => undefined as undefined),
  authoredPrompt: vi.fn(() => undefined as undefined),
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

const subscribeAnonymously = (sessionId: string, input: SubscribeInput = subscribeInput) =>
  inSession(sessionId, null, () =>
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

it("refuses a channel that defines onEvent without catalog", () => {
  expect(() =>
    offeredSubscriptions([{ name: "github", definition: { onEvent: () => null } }] as never),
  ).toThrow('Channel "github" defines onEvent without catalog.');
});

const eventDefinitions = [
  {
    name: "check_suite.completed",
    description: "A check suite finished.",
    inputSchema: defineJsonSchema({
      type: "object",
      additionalProperties: false,
      required: ["owner", "repo"],
      properties: {
        owner: { type: "string", pattern: "^[^A-Z]+$" },
        repo: { type: "string", pattern: "^[^A-Z]+$" },
      },
    }),
  },
  {
    name: "check_suite.requested",
    description: "A check suite was requested.",
    inputSchema: defineJsonSchema({ type: "object" }),
  },
  { name: "push", description: "A push.", inputSchema: defineJsonSchema({ type: "object" }) },
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

it("does not let another anonymous session stop an anonymous subscription", async () => {
  const { id } = (await subscribeAnonymously("a1")) as { id: string };

  await expect(inSession("a2", null, () => stop(id))).rejects.toThrow(
    "Unknown subscription for this caller.",
  );
  expect(host.retire).not.toHaveBeenCalled();
});

it("does not let another session stop a subscription made under the synthetic anonymous identity", async () => {
  const { id } = (await inSession("a1", ANONYMOUS_SESSION_AUTH_CONTEXT, () =>
    subscribeToChannel(offeredSubscriptions(channels), subscribeInput, undefined),
  )) as { id: string };

  await expect(inSession("a2", ANONYMOUS_SESSION_AUTH_CONTEXT, () => stop(id))).rejects.toThrow(
    "Unknown subscription for this caller.",
  );
  expect(host.retire).not.toHaveBeenCalled();

  await expect(inSession("a1", ANONYMOUS_SESSION_AUTH_CONTEXT, () => stop(id))).resolves.toEqual({
    id,
    status: "stopping",
  });
});

it("lets an anonymous session stop its own subscription", async () => {
  const { id } = (await subscribeAnonymously("a1")) as { id: string };

  await expect(inSession("a1", null, () => stop(id))).resolves.toEqual({
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

describe("onSubscribe", () => {
  const subscribeWith = (onSubscribe: unknown, user = "rui") => {
    const offered = offeredSubscriptions([
      {
        name: "github",
        definition: { onEvent: () => null, catalog: () => checksFinished, onSubscribe },
      },
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

describe("a turn another person's message joined", () => {
  function steered<T>(run: () => Promise<T>) {
    const ctx = new ContextContainer();
    ctx.setVirtualContext(SessionIdKey, "s1");
    ctx.setVirtualContext(AuthKey, authOf("rui"));
    ctx.setVirtualContext(SessionAgentKey, { compiled: { bundle: true } } as never);
    ctx.set(SteeredByKey, [authOf("bob")]);
    return contextStorage.run(ctx, () => withModelCall(run));
  }

  it("refuses a subscribe from the model, as the caller's identity would carry to future turns", async () => {
    await expect(
      steered(() => subscribeToChannel(offeredSubscriptions(channels), subscribeInput, undefined)),
    ).rejects.toThrow("can't use the caller's identity");
    expect(host.start).not.toHaveBeenCalled();
  });

  it("refuses to stop a channel subscription from the model", async () => {
    await subscribeAs("s1", "rui");
    const [id] = [...host.bindings.keys()];
    await expect(steered(() => stop(id!))).rejects.toThrow("can't use the caller's identity");
    expect(host.retire).not.toHaveBeenCalled();
  });

  it("still subscribes outside a model call, as a deployed route handler does", async () => {
    const ctx = new ContextContainer();
    ctx.setVirtualContext(SessionIdKey, "s1");
    ctx.setVirtualContext(AuthKey, authOf("rui"));
    ctx.setVirtualContext(SessionAgentKey, { compiled: { bundle: true } } as never);
    ctx.set(SteeredByKey, [authOf("bob")]);
    const result = await contextStorage.run(ctx, () =>
      subscribeToChannel(offeredSubscriptions(channels), subscribeInput, undefined),
    );
    expect(result).toMatchObject({ status: "active" });
  });
});

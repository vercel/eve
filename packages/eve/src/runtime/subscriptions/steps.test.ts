import { beforeEach, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  joinAckNamespace,
  subscriptionHookToken,
  subscriptionKeyHookToken,
  type SubscriptionBinding,
} from "./state.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_message: string, _options: unknown) => ({})),
  attach: vi.fn((_sessionId: string) => ({ send: mocks.send })),
  attachFactory: vi.fn((_runtime: unknown, _defaults: unknown) => mocks.attach),
  hooks: new Set<string>(),
  getHookByToken: vi.fn(),
  resumeHook: vi.fn(async (_token: string, _message: unknown) => {}),
  startWorkflow: vi.fn(async (_reference: unknown, _args: unknown) => ({ runId: "run-new" })),
  startWorkflowOnDeployment: vi.fn(
    async (_reference: unknown, _args: unknown, _deploymentId: string) => ({ runId: "run-new" }),
  ),
  readFirstPublished: vi.fn(),
  writes: [] as { namespace: string; value: unknown }[],
  context: { current: undefined as unknown },
}));

vi.mock("#channel/session.js", () => ({ createAttachSessionFn: mocks.attachFactory }));
vi.mock("#context/serialize.js", () => ({ deserializeContext: async () => mocks.context.current }));
vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: (input: unknown) => ({ runtime: input }),
  startWorkflowOnCurrentDeployment: mocks.startWorkflow,
  startWorkflowOnDeployment: mocks.startWorkflowOnDeployment,
}));
vi.mock("#execution/workflow-references.js", () => ({
  subscriptionDeliveryWorkflowReference: "delivery-reference",
  subscriptionKeyWorkflowReference: "key-reference",
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  getHookByToken: mocks.getHookByToken,
  resumeHook: mocks.resumeHook,
}));
vi.mock("./published-outcome.js", () => ({ readFirstPublished: mocks.readFirstPublished }));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "owner-run" }),
  getWritable: ({ namespace }: { namespace: string }) => ({
    getWriter: () => ({
      write: async (value: unknown) => {
        mocks.writes.push({ namespace, value });
      },
      releaseLock: () => {},
    }),
  }),
}));

const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
const {
  dispatchSubscriptionStep,
  fanOutEventStep,
  forwardJoinStep,
  joinKeyStep,
  leaveKeyStep,
  startSubscriptionDeliveryStep,
} = await import("./steps.js");

const subscriberAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "hub",
  issuer: "hub",
  principalId: "rui",
  principalType: "user",
};
const otherAuth: SessionAuthContext = { ...subscriberAuth, principalId: "mallory" };
const source = { kind: "channel", name: "github" } as const;
const binding: SubscriptionBinding = {
  id: "binding-1",
  source: {
    kind: "channel",
    name: "github",
    event: "checks_finished",
    key: "vercel/eve#7",
    input: { pull: 7 },
    ttlMs: null,
  },
  sessionId: "session-1",
  executionPrincipal: "rui",
  auth: subscriberAuth,
};
const keyToken = subscriptionKeyHookToken(source, "vercel/eve#7");
const bundleWith = (subscriptions: object | undefined) => ({
  compiledArtifactsSource: { kind: "disk", appRoot: "/virtual" },
  resolvedAgent: { channels: [{ name: "github", definition: { subscriptions } }] },
});
const useDeclared = (subscriptions: object | undefined, auth: SessionAuthContext | null = null) => {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionAgentKey, { compiled: bundleWith(subscriptions) } as never);
  ctx.setVirtualContext(AuthKey, auth);
  mocks.context.current = ctx;
};
const useSubscriptions = (
  declaration: object | undefined,
  auth: SessionAuthContext | null = null,
) =>
  useDeclared(
    declaration === undefined
      ? undefined
      : { description: "d", inputSchema: {}, onEvent: () => true, ...declaration },
    auth,
  );
const delivery = (id: string, data: Record<string, unknown> = { id }) => ({
  binding,
  serializedContext: {},
  event: { id, data } as never,
});
const notFound = () => new HookNotFoundError("token");
const joinMessages = () =>
  mocks.resumeHook.mock.calls
    .filter(([token]) => token === keyToken)
    .map(([, message]) => message as { kind: string; bindingId: string; ackId: string });
const ackIdsRead = () =>
  mocks.readFirstPublished.mock.calls.map(([, namespace]) => namespace as string);

beforeEach(() => {
  for (const mock of Object.values(mocks)) if (vi.isMockFunction(mock)) mock.mockClear();
  mocks.hooks.clear();
  mocks.writes.length = 0;
  mocks.getHookByToken.mockReset();
  mocks.getHookByToken.mockImplementation(async (token: string) => {
    if (!mocks.hooks.has(token)) throw notFound();
    return { runId: "run-holding" };
  });
  mocks.resumeHook.mockReset();
  mocks.resumeHook.mockImplementation(async (token: string) => {
    if (!mocks.hooks.has(token)) throw notFound();
  });
  mocks.readFirstPublished.mockReset();
  mocks.readFirstPublished.mockResolvedValue({ kind: "value", value: { joined: true } });
  useSubscriptions({ description: "d", inputSchema: {} });
});

it("sends onEvent's message queued, as the subscriber, with an idempotency key per binding and event", async () => {
  const onEvent = vi.fn(async () => "Checks finished");
  useSubscriptions({ onEvent });

  await dispatchSubscriptionStep(delivery("e1", { ok: true }));
  await dispatchSubscriptionStep(delivery("e1", { ok: true }));
  await dispatchSubscriptionStep(delivery("e2"));
  await dispatchSubscriptionStep({ ...delivery("e1"), binding: { ...binding, id: "binding-2" } });

  expect(onEvent).toHaveBeenCalledWith({
    auth: subscriberAuth,
    sessionId: "session-1",
    event: { id: "e1", name: "checks_finished", data: { ok: true } },
    subscription: {
      id: "binding-1",
      channelName: "github",
      event: "checks_finished",
      input: { pull: 7 },
      sessionId: "session-1",
    },
  });
  expect(mocks.attachFactory.mock.calls[0]![1]).toMatchObject({ turnPolicy: "queue" });
  expect(mocks.attach).toHaveBeenCalledWith("session-1");
  const [message, options] = mocks.send.mock.calls[0]!;
  expect(message).toBe("Checks finished");
  expect(options).toMatchObject({ auth: subscriberAuth, turnPolicy: "queue" });

  const keys = mocks.send.mock.calls.map(
    ([, sent]) => (sent as { idempotencyKey: string }).idempotencyKey,
  );
  expect(keys[0]).toMatch(/^eve:subscription:/);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  expect(keys[3]).not.toBe(keys[0]);
});

it("sends under the subscriber's auth even when the event names another principal", async () => {
  useSubscriptions({ onEvent: () => "Mallory commented" }, otherAuth);

  await dispatchSubscriptionStep(
    delivery("e1", { principalId: "mallory", auth: otherAuth, actor: "mallory" }),
  );

  expect(mocks.send).toHaveBeenCalledTimes(1);
  const [, options] = mocks.send.mock.calls[0]!;
  expect(options).toMatchObject({ auth: subscriberAuth, turnPolicy: "queue" });
  expect(options).not.toMatchObject({ auth: otherAuth });
  expect((mocks.context.current as ContextContainer).get(AuthKey)).toEqual(subscriberAuth);
});

it("sends the event's data as JSON when onEvent returns true", async () => {
  useSubscriptions({ onEvent: () => true });
  await dispatchSubscriptionStep(delivery("e1", { pull: 7 }));
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0]![0]).toBe(JSON.stringify({ pull: 7 }));
});

it("runs onEvent inside the subscriber's context", async () => {
  let seen: unknown;
  useSubscriptions({
    onEvent: () => {
      seen = contextStorage.getStore()?.get(AuthKey);
      return "Checks finished";
    },
  });
  await dispatchSubscriptionStep(delivery("e1"));
  expect(seen).toEqual(subscriberAuth);
});

it.each([undefined, false])("sends nothing when onEvent returns %s", async (decision) => {
  useSubscriptions({ onEvent: () => decision });
  await dispatchSubscriptionStep(delivery("e1"));
  expect(mocks.send).not.toHaveBeenCalled();
});

it("lets onEvent filter by event name", async () => {
  useSubscriptions({ onEvent: ({ event }: { event: { name: string } }) => event.name === "other" });
  await dispatchSubscriptionStep(delivery("e1"));
  expect(mocks.send).not.toHaveBeenCalled();
});

it("sends nothing once the channel no longer has subscriptions", async () => {
  useSubscriptions(undefined);
  await dispatchSubscriptionStep(delivery("e1"));
  expect(mocks.send).not.toHaveBeenCalled();
});

it("retires the subscription when its session has ended, and fails a send that may be retried", async () => {
  const { SessionNotActiveError } = await import("#channel/session-not-active-error.js");
  mocks.hooks.add(subscriptionHookToken("binding-1"));
  mocks.send.mockRejectedValueOnce(new SessionNotActiveError());

  await dispatchSubscriptionStep(delivery("e1"));

  expect(mocks.resumeHook).toHaveBeenCalledWith(subscriptionHookToken("binding-1"), {
    kind: "retire",
  });

  mocks.resumeHook.mockClear();
  mocks.send.mockRejectedValueOnce(new SessionNotActiveError({ retryable: true }));
  await expect(dispatchSubscriptionStep(delivery("e2"))).rejects.toThrow("not ready");
  expect(mocks.resumeHook).not.toHaveBeenCalled();
});

it("starts the delivery workflow on the deployment that accepted the event", async () => {
  await startSubscriptionDeliveryStep({
    ...delivery("e1"),
    event: { id: "e1", data: {}, acceptedDeploymentId: "dpl_new" },
  });

  expect(mocks.startWorkflowOnDeployment).toHaveBeenCalledExactlyOnceWith(
    "delivery-reference",
    [expect.objectContaining({ event: { id: "e1", data: {}, acceptedDeploymentId: "dpl_new" } })],
    "dpl_new",
  );
  expect(mocks.startWorkflow).not.toHaveBeenCalled();
});

it("starts the delivery workflow on the current deployment when the event names none", async () => {
  await startSubscriptionDeliveryStep(delivery("e1"));

  expect(mocks.startWorkflow).toHaveBeenCalledExactlyOnceWith("delivery-reference", [
    expect.objectContaining({ binding }),
  ]);
  expect(mocks.startWorkflowOnDeployment).not.toHaveBeenCalled();
});

it("hands the event to each owner hook and reports the owners that ended", async () => {
  mocks.hooks.add(subscriptionHookToken("a"));
  mocks.hooks.add(subscriptionHookToken("b"));
  const event = { id: "e1", data: { ok: true } };

  const gone = await fanOutEventStep({ bindingIds: ["a", "gone", "b"], event });

  expect(gone).toEqual(["gone"]);
  expect(mocks.resumeHook.mock.calls).toEqual([
    [subscriptionHookToken("a"), { kind: "delivery", event }],
    [subscriptionHookToken("gone"), { kind: "delivery", event }],
    [subscriptionHookToken("b"), { kind: "delivery", event }],
  ]);
});

it("rethrows a failure other than a missing hook while fanning out", async () => {
  mocks.resumeHook.mockRejectedValue(new Error("world unavailable"));
  await expect(
    fanOutEventStep({ bindingIds: ["a"], event: { id: "e1", data: {} } }),
  ).rejects.toThrow("world unavailable");
});

it("joins the running key run through its hook and returns on its acknowledgement", async () => {
  mocks.hooks.add(keyToken);

  await joinKeyStep({ binding, key: "vercel/eve#7" });

  const [join] = joinMessages();
  expect(join).toEqual({ kind: "join", bindingId: "binding-1", ackId: expect.any(String) });
  expect(joinMessages()).toHaveLength(1);
  expect(mocks.readFirstPublished).toHaveBeenCalledExactlyOnceWith(
    "run-holding",
    joinAckNamespace(join!.ackId),
  );
  expect(mocks.startWorkflow).not.toHaveBeenCalled();
});

it("starts the key run with the binding as first member when no key hook exists", async () => {
  await joinKeyStep({ binding, key: "vercel/eve#7" });

  expect(mocks.startWorkflow).toHaveBeenCalledExactlyOnceWith("key-reference", [
    { source, key: "vercel/eve#7", first: "binding-1", ackId: expect.any(String) },
  ]);
  const [{ ackId }] = mocks.startWorkflow.mock.calls[0]![1] as [{ ackId: string }];
  expect(mocks.readFirstPublished).toHaveBeenCalledExactlyOnceWith(
    "run-new",
    joinAckNamespace(ackId),
  );
});

it("joins again when the key run ends without acknowledging, starting a fresh run if the hook is gone", async () => {
  mocks.hooks.add(keyToken);
  mocks.readFirstPublished.mockImplementationOnce(async () => {
    mocks.hooks.delete(keyToken);
    return { kind: "ended" };
  });

  await joinKeyStep({ binding, key: "vercel/eve#7" });

  const [firstJoin] = joinMessages();
  expect(joinMessages()).toHaveLength(1);
  expect(mocks.startWorkflow).toHaveBeenCalledExactlyOnceWith("key-reference", [
    { source, key: "vercel/eve#7", first: "binding-1", ackId: expect.any(String) },
  ]);
  const [{ ackId }] = mocks.startWorkflow.mock.calls[0]![1] as [{ ackId: string }];
  expect(ackId).not.toBe(firstJoin!.ackId);
  expect(ackIdsRead()).toEqual([joinAckNamespace(firstJoin!.ackId), joinAckNamespace(ackId)]);
  expect(mocks.readFirstPublished.mock.calls.map(([runId]) => runId)).toEqual([
    "run-holding",
    "run-new",
  ]);
});

it("joins again when the first wait gives up, resuming the same hook with a new acknowledgement id", async () => {
  mocks.hooks.add(keyToken);
  mocks.readFirstPublished.mockResolvedValueOnce({ kind: "abandoned" });

  await joinKeyStep({ binding, key: "vercel/eve#7" });

  const joins = joinMessages();
  expect(joins).toHaveLength(2);
  expect(joins[1]!.ackId).not.toBe(joins[0]!.ackId);
  expect(mocks.startWorkflow).not.toHaveBeenCalled();
});

it("follows a forwardedTo acknowledgement to the run that took the join", async () => {
  mocks.hooks.add(keyToken);
  mocks.readFirstPublished
    .mockResolvedValueOnce({ kind: "value", value: { forwardedTo: "run-winner" } })
    .mockResolvedValueOnce({ kind: "value", value: { joined: true } });

  await joinKeyStep({ binding, key: "vercel/eve#7" });

  const [join] = joinMessages();
  expect(joinMessages()).toHaveLength(1);
  expect(mocks.readFirstPublished.mock.calls).toEqual([
    ["run-holding", joinAckNamespace(join!.ackId)],
    ["run-winner", joinAckNamespace(join!.ackId)],
  ]);
});

it("gives up with an error after five attempts that never acknowledge", async () => {
  mocks.hooks.add(keyToken);
  mocks.readFirstPublished.mockResolvedValue({ kind: "ended" });

  await expect(joinKeyStep({ binding, key: "vercel/eve#7" })).rejects.toThrow(
    "key run kept ending",
  );

  expect(mocks.readFirstPublished).toHaveBeenCalledTimes(5);
  expect(new Set(joinMessages().map((message) => message.ackId)).size).toBe(5);
});

it("rethrows a failure other than a missing hook while joining", async () => {
  mocks.resumeHook.mockRejectedValue(new Error("world unavailable"));
  mocks.hooks.add(keyToken);
  await expect(joinKeyStep({ binding, key: "vercel/eve#7" })).rejects.toThrow("world unavailable");
  expect(mocks.startWorkflow).not.toHaveBeenCalled();
});

it("tells the key run the subscription is leaving, and nothing when no run holds the key", async () => {
  await leaveKeyStep({ binding, key: "vercel/eve#7" });
  expect(mocks.resumeHook).not.toHaveBeenCalled();

  mocks.hooks.add(keyToken);
  await leaveKeyStep({ binding, key: "vercel/eve#7" });
  expect(mocks.resumeHook).toHaveBeenCalledExactlyOnceWith(keyToken, {
    kind: "leave",
    bindingId: "binding-1",
  });
});

it("forwards a join to the winning run and publishes where it went", async () => {
  mocks.hooks.add(keyToken);

  await forwardJoinStep({
    source,
    key: "vercel/eve#7",
    bindingId: "binding-1",
    ackId: "ack-1",
    to: "run-winner",
  });

  expect(mocks.resumeHook).toHaveBeenCalledExactlyOnceWith(keyToken, {
    kind: "join",
    bindingId: "binding-1",
    ackId: "ack-1",
  });
  expect(mocks.writes).toEqual([
    { namespace: joinAckNamespace("ack-1"), value: { forwardedTo: "run-winner" } },
  ]);
});

it("publishes nothing when the winning run is already gone, so the owner joins again", async () => {
  await forwardJoinStep({
    source,
    key: "vercel/eve#7",
    bindingId: "binding-1",
    ackId: "ack-1",
    to: "run-winner",
  });

  expect(mocks.writes).toEqual([]);
});

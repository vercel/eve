import { beforeEach, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { channelKeyHookToken, channelSubscriptionHookToken } from "./state.js";
import type { ChannelSubscriptionBinding } from "./state.js";

const { send, attach, attachFactory, resumeHook, startWorkflow } = vi.hoisted(() => {
  const send = vi.fn(async (_message: string, _options: unknown) => ({}));
  const attach = vi.fn((_sessionId: string) => ({ send }));
  const attachFactory = vi.fn((_runtime: unknown, _defaults: unknown) => attach);
  const resumeHook = vi.fn(async (_token: string, _message: unknown) => {});
  const startWorkflow = vi.fn(async (_reference: unknown, _args: unknown) => ({ runId: "run-1" }));
  return { send, attach, attachFactory, resumeHook, startWorkflow };
});
const context = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("#channel/session.js", () => ({ createAttachSessionFn: attachFactory }));
vi.mock("#context/serialize.js", () => ({ deserializeContext: async () => context.current }));
vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: (input: unknown) => ({ runtime: input }),
  startWorkflowOnCurrentDeployment: startWorkflow,
}));
vi.mock("#execution/workflow-references.js", () => ({
  channelSubscriptionDeliveryWorkflowReference: "delivery-reference",
  channelSubscriptionKeyWorkflowReference: "key-reference",
}));
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook }));
vi.mock("#compiled/@workflow/core/index.js", () => ({ getWritable: vi.fn() }));

const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
const { dispatchChannelSubscriptionStep, fanOutChannelEventStep, joinChannelKeyStep } =
  await import("./steps.js");

const subscriberAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "hub",
  issuer: "hub",
  principalId: "rui",
  principalType: "user",
};
const binding: ChannelSubscriptionBinding = {
  id: "binding-1",
  channelName: "github",
  key: "vercel/eve#7",
  input: { pull: 7 },
  sessionId: "session-1",
  executionPrincipal: "rui",
  auth: subscriberAuth,
  ttlMs: null,
};
const bundleWith = (subscriptions: object | undefined) => ({
  compiledArtifactsSource: { kind: "disk", appRoot: "/virtual" },
  resolvedAgent: { channels: [{ name: "github", definition: { subscriptions } }] },
});
const useSubscriptions = (subscriptions: object | undefined) => {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionAgentKey, { compiled: bundleWith(subscriptions) } as never);
  context.current = ctx;
};
const delivery = (id: string, data: Record<string, unknown> = { id }) => ({
  binding,
  serializedContext: {},
  event: { id, data } as never,
});
const notFound = () => new HookNotFoundError("token");

beforeEach(() => {
  send.mockClear();
  attach.mockClear();
  attachFactory.mockClear();
  resumeHook.mockReset();
  resumeHook.mockResolvedValue(undefined);
  startWorkflow.mockClear();
  useSubscriptions({ description: "d", inputSchema: {}, onSubscribe: () => ({ key: "k" }) });
});

it("sends onEvent's message queued, as the subscriber, with an idempotency key per binding and event", async () => {
  const onEvent = vi.fn(async () => "Checks finished");
  useSubscriptions({ onEvent });

  await dispatchChannelSubscriptionStep(delivery("e1", { ok: true }));
  await dispatchChannelSubscriptionStep(delivery("e1", { ok: true }));
  await dispatchChannelSubscriptionStep(delivery("e2"));
  await dispatchChannelSubscriptionStep({
    ...delivery("e1"),
    binding: { ...binding, id: "binding-2" },
  });

  expect(onEvent).toHaveBeenCalledWith({
    auth: subscriberAuth,
    sessionId: "session-1",
    event: { id: "e1", data: { ok: true } },
    subscription: {
      id: "binding-1",
      channelName: "github",
      input: { pull: 7 },
      key: "vercel/eve#7",
      sessionId: "session-1",
    },
  });
  expect(attachFactory.mock.calls[0]![1]).toMatchObject({ turnPolicy: "queue" });
  expect(attach).toHaveBeenCalledWith("session-1");
  const [message, options] = send.mock.calls[0]!;
  expect(message).toBe("Checks finished");
  expect(options).toMatchObject({ auth: subscriberAuth, turnPolicy: "queue" });
  expect((context.current as ContextContainer).get(AuthKey)).toEqual(subscriberAuth);

  const keys = send.mock.calls.map(
    ([, sent]) => (sent as { idempotencyKey: string }).idempotencyKey,
  );
  expect(keys[0]).toBe(keys[1]);
  expect(keys[2]).not.toBe(keys[0]);
  expect(keys[3]).not.toBe(keys[0]);
});

it("sends the event's data as JSON when the channel has no onEvent", async () => {
  useSubscriptions({});
  await dispatchChannelSubscriptionStep(delivery("e1", { pull: 7 }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toBe(JSON.stringify({ pull: 7 }));
});

it("sends nothing when onEvent returns undefined", async () => {
  useSubscriptions({ onEvent: () => undefined });
  await dispatchChannelSubscriptionStep(delivery("e1"));
  expect(send).not.toHaveBeenCalled();
});

it("sends nothing once the channel no longer has subscriptions", async () => {
  useSubscriptions(undefined);
  await dispatchChannelSubscriptionStep(delivery("e1"));
  expect(send).not.toHaveBeenCalled();
});

it("hands the event to each member's owner hook and skips members that ended", async () => {
  resumeHook.mockImplementation(async (token) => {
    if (token === channelSubscriptionHookToken("gone")) throw notFound();
  });
  const event = { id: "e1", data: { ok: true } };

  await fanOutChannelEventStep({ bindingIds: ["a", "gone", "b"], event });

  expect(resumeHook.mock.calls).toEqual([
    [channelSubscriptionHookToken("a"), { kind: "delivery", event }],
    [channelSubscriptionHookToken("gone"), { kind: "delivery", event }],
    [channelSubscriptionHookToken("b"), { kind: "delivery", event }],
  ]);
});

it("rethrows a failure other than a missing hook while fanning out", async () => {
  resumeHook.mockRejectedValue(new Error("world unavailable"));
  await expect(
    fanOutChannelEventStep({ bindingIds: ["a"], event: { id: "e1", data: {} } }),
  ).rejects.toThrow("world unavailable");
});

it("joins the running key workflow through its hook", async () => {
  await joinChannelKeyStep(binding);
  expect(resumeHook).toHaveBeenCalledWith(channelKeyHookToken("github", "vercel/eve#7"), {
    kind: "join",
    bindingId: "binding-1",
  });
  expect(startWorkflow).not.toHaveBeenCalled();
});

it("starts the key workflow with the binding as first member when no key hook exists", async () => {
  resumeHook.mockRejectedValue(notFound());
  await joinChannelKeyStep(binding);
  expect(startWorkflow).toHaveBeenCalledWith("key-reference", [
    { channelName: "github", key: "vercel/eve#7", first: "binding-1" },
  ]);
});

it("rethrows a failure other than a missing hook while joining", async () => {
  resumeHook.mockRejectedValue(new Error("world unavailable"));
  await expect(joinChannelKeyStep(binding)).rejects.toThrow("world unavailable");
  expect(startWorkflow).not.toHaveBeenCalled();
});

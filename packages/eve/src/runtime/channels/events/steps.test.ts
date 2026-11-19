import { beforeEach, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ChannelEventBinding } from "./state.js";

const { send, attach, attachFactory } = vi.hoisted(() => {
  const send = vi.fn(async (_message: string, _options: unknown) => ({}));
  const attach = vi.fn((_sessionId: string) => ({ send }));
  const attachFactory = vi.fn((_runtime: unknown, _defaults: unknown) => attach);
  return { send, attach, attachFactory };
});
const context = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("#channel/session.js", () => ({ createAttachSessionFn: attachFactory }));
vi.mock("#context/serialize.js", () => ({ deserializeContext: async () => context.current }));
vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: (input: unknown) => ({ runtime: input }),
  startWorkflowOnCurrentDeployment: vi.fn(),
}));

const { dispatchChannelEventStep } = await import("./steps.js");

const subscriberAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "hub",
  issuer: "hub",
  principalId: "rui",
  principalType: "user",
};
const binding: ChannelEventBinding = {
  id: "binding-1",
  channelName: "github",
  event: "checks_finished",
  arguments: {},
  sessionId: "session-1",
  auth: subscriberAuth,
  executionPrincipal: "rui",
  ttlMs: null,
};
const bundleWith = (subscriptions: object | undefined) => ({
  compiledArtifactsSource: { kind: "disk", appRoot: "/virtual" },
  resolvedAgent: { channels: [{ name: "github", definition: { subscriptions } }] },
});

beforeEach(() => {
  send.mockClear();
  attach.mockClear();
  attachFactory.mockClear();
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionAgentKey, {
    compiled: bundleWith({ checks_finished: {} }),
  } as never);
  context.current = ctx;
});

it("queues the event in the subscribing session under the subscriber's saved auth", async () => {
  await dispatchChannelEventStep({
    binding,
    serializedContext: {},
    delivery: { id: "d1", message: "Checks finished" },
  });

  expect(attachFactory.mock.calls[0]![1]).toMatchObject({ turnPolicy: "queue" });
  expect(attach).toHaveBeenCalledWith("session-1");
  expect(send).toHaveBeenCalledTimes(1);
  const [message, options] = send.mock.calls[0]!;
  expect(message).toBe("Checks finished");
  expect(options).toMatchObject({ auth: subscriberAuth, turnPolicy: "queue" });
  expect((context.current as ContextContainer).get(AuthKey)).toEqual(subscriberAuth);
});

it("sends the same occurrence under the same idempotency key every time", async () => {
  const input = { binding, serializedContext: {}, delivery: { id: "d1", message: "m" } };
  await dispatchChannelEventStep(input);
  await dispatchChannelEventStep(input);
  await dispatchChannelEventStep({ ...input, delivery: { id: "d2", message: "m" } });

  const keys = send.mock.calls.map(
    ([, options]) => (options as { idempotencyKey: string }).idempotencyKey,
  );
  expect(keys[0]).toBe(keys[1]);
  expect(keys[2]).not.toBe(keys[0]);
});

it("delivers nothing once the channel no longer offers the event", async () => {
  (context.current as ContextContainer).setVirtualContext(SessionAgentKey, {
    compiled: bundleWith({}),
  } as never);
  await dispatchChannelEventStep({
    binding,
    serializedContext: {},
    delivery: { id: "d1", message: "m" },
  });
  expect(send).not.toHaveBeenCalled();
});

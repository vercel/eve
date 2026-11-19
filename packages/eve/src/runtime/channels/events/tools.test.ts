import { beforeEach, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ChannelEventBinding, ChannelEventStatus } from "./state.js";
import { channelEventId } from "./id.js";

const host = vi.hoisted(() => ({
  bindings: new Map<string, ChannelEventBinding>(),
  start: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("#execution/hosts.js", () => ({
  installedDurableHost: () => ({
    channelEvents: {
      start: host.start,
      retire: host.retire,
      async find(id: string) {
        const binding = host.bindings.get(id);
        return binding && { binding, status: undefined };
      },
    },
  }),
}));

const { channelEventTools } = await import("./tools.js");

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["owner", "pull"],
  properties: { owner: { type: "string" }, pull: { type: "integer" } },
};
const channels = [
  {
    name: "github",
    definition: {
      subscriptions: {
        checks_finished: {
          description: "Checks finished.",
          inputSchema,
          normalize: (input: Record<string, unknown>) => ({
            ...input,
            owner: String(input.owner).toLowerCase(),
          }),
        },
      },
    },
  },
] as never;

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
  const tool = channelEventTools(channels)![name] as unknown as {
    execute(input: unknown, options: { abortSignal?: AbortSignal }): Promise<unknown>;
  };
  return tool.execute(input, {});
};

const status = (sessionId: string, id: string): ChannelEventStatus => ({
  id,
  event: "checks_finished",
  arguments: { owner: "vercel", pull: 7 },
  sessionId,
  status: "active",
  expiresAt: null,
});

beforeEach(() => {
  host.bindings.clear();
  host.start.mockReset();
  host.retire.mockReset();
  host.start.mockImplementation(async (binding: ChannelEventBinding) => {
    host.bindings.set(binding.id, binding);
    return status(binding.sessionId, binding.id);
  });
  host.retire.mockResolvedValue(true);
});

it("offers one subscribe tool per event plus get and stop, or nothing without events", () => {
  expect(Object.keys(channelEventTools(channels)!)).toEqual([
    "subscribe_github_checks_finished",
    "get_event_subscription",
    "stop_event_subscription",
  ]);
  expect(channelEventTools([{ name: "slack", definition: {} }] as never)).toBeNull();
});

it("subscribes under the caller's session and auth with arguments normalized", async () => {
  const result = await inSession("s1", authOf("rui"), () =>
    call("subscribe_github_checks_finished", {
      arguments: { owner: "Vercel", pull: 7 },
      ttlMs: null,
    }),
  );

  const id = channelEventId("github", "checks_finished", { owner: "vercel", pull: 7 });
  expect(result).toMatchObject({ id, sessionId: "s1", status: "active" });
  expect(host.start.mock.calls[0]![0]).toMatchObject({
    id,
    channelName: "github",
    sessionId: "s1",
    auth: authOf("rui"),
    arguments: { owner: "vercel", pull: 7 },
    ttlMs: null,
  });
});

it("rejects arguments that do not match the event's schema", async () => {
  await expect(
    inSession("s1", authOf("rui"), () =>
      call("subscribe_github_checks_finished", { arguments: { owner: "v" }, ttlMs: null }),
    ),
  ).rejects.toThrow("do not match");
  expect(host.start).not.toHaveBeenCalled();
});

it("refuses a second session subscribing to an event another principal already holds", async () => {
  const subscribe = (session: string, user: string) =>
    inSession(session, authOf(user), () =>
      call("subscribe_github_checks_finished", {
        arguments: { owner: "vercel", pull: 7 },
        ttlMs: null,
      }),
    );
  await subscribe("s1", "rui");
  host.start.mockImplementation(async (binding: ChannelEventBinding) => status("s1", binding.id));
  await expect(subscribe("s2", "someone-else")).rejects.toThrow("Another session already holds");
});

it("lets only the principal that subscribed get or stop a subscription", async () => {
  const id = channelEventId("github", "checks_finished", { owner: "vercel", pull: 7 });
  await inSession("s1", authOf("rui"), () =>
    call("subscribe_github_checks_finished", {
      arguments: { owner: "vercel", pull: 7 },
      ttlMs: null,
    }),
  );

  await expect(
    inSession("s9", authOf("someone-else"), () => call("stop_event_subscription", { id })),
  ).rejects.toThrow("Unknown subscription");
  expect(host.retire).not.toHaveBeenCalled();

  await expect(
    inSession("s2", authOf("rui"), () => call("stop_event_subscription", { id })),
  ).resolves.toEqual({ id, status: "stopping" });
  expect(host.retire).toHaveBeenCalledWith(id);
});

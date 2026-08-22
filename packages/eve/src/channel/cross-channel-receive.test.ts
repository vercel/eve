import { describe, expect, it, vi } from "vitest";

import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import {
  createCrossChannelToFn,
  type CrossChannelTarget,
  type CrossChannelToFn,
} from "#channel/cross-channel-receive.js";
import type { Session } from "#channel/session.js";
import type { Runtime } from "#channel/types.js";
import type { SlackChannel, SlackReceiveTarget } from "#public/channels/slack/slackChannel.js";

function makeRuntime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn(),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn(),
  };
}

function makeSession(): Session {
  return {
    id: "sess_1",
    async cancel() {
      return { status: "no_active_turn" };
    },
    async getEventStream() {
      return new ReadableStream();
    },
    async getStreamTailIndex() {
      return -1;
    },
    async send() {
      return { sessionId: "sess_1", status: "accepted" };
    },
    async respond() {
      return { sessionId: "sess_1", status: "accepted" };
    },
    async compact() {
      return { status: "no_active_session" };
    },
    async clear() {
      return { status: "no_active_session" };
    },
    async reset() {
      return { status: "no_active_session" };
    },
  };
}

function makeChannel(name: string): {
  target: CrossChannelTarget;
  receive: ReturnType<typeof vi.fn>;
  definition: CompiledChannel;
} {
  const receive = vi.fn().mockResolvedValue(makeSession());
  const definition: CompiledChannel = {
    __kind: CHANNEL_SENTINEL,
    routes: [{ method: "POST", path: `/${name}`, handler: async () => new Response("ok") }],
    adapter: { kind: `channel:${name}` },
    receive,
  };
  return {
    target: {
      name,
      definition,
      receive,
      adapter: definition.adapter,
    },
    receive,
    definition,
  };
}

describe("createCrossChannelToFn", () => {
  it("accepts a Slack channel whose receive target is a closed interface", () => {
    const typeOnlyCalls = (to: CrossChannelToFn, slack: SlackChannel) => {
      const target: SlackReceiveTarget = { channelId: "C1" };
      to(slack, target);
      // @ts-expect-error Slack receive targets require a channel id.
      to(slack, {});
    };

    expect(typeOnlyCalls).toBeTypeOf("function");
  });

  it("requires an eve channel reference at compile time", () => {
    const fn = createCrossChannelToFn(makeRuntime(), []);
    const invalidCalls = () => {
      // @ts-expect-error arbitrary strings are not authored channel references.
      fn("slack", {});
      // @ts-expect-error arbitrary objects are not authored channel references.
      fn({}, {});
    };
    expect(invalidCalls).toBeTypeOf("function");
  });

  it("delegates to the target channel's receive with a per-target send", async () => {
    const slack = makeChannel("slack");
    const fn = createCrossChannelToFn(makeRuntime(), [slack.target]);

    const session = await fn(slack.definition, { channelId: "C1" }).send("hello", {
      auth: { attributes: {}, authenticator: "app", principalId: "u", principalType: "user" },
    });

    expect(session.id).toBe("sess_1");
    expect(slack.receive).toHaveBeenCalledTimes(1);
    const [input, ctx] = slack.receive.mock.calls[0]!;
    expect(input).toEqual({
      message: "hello",
      target: { channelId: "C1" },
      auth: expect.objectContaining({ principalId: "u" }),
    });
    expect(typeof ctx.from).toBe("function");
  });

  it("resolves the target by reference identity even when multiple channels are registered", async () => {
    const slack = makeChannel("slack");
    const twilio = makeChannel("twilio");
    const fn = createCrossChannelToFn(makeRuntime(), [slack.target, twilio.target]);

    await fn(twilio.definition, {}).send("ping", { auth: null });

    expect(twilio.receive).toHaveBeenCalledTimes(1);
    expect(slack.receive).not.toHaveBeenCalled();
  });

  it("resolves a duplicated compiled channel reference by its unique route fingerprint", async () => {
    const target = makeChannel("target");
    const duplicateDefinition: CompiledChannel = {
      __kind: CHANNEL_SENTINEL,
      routes: [...target.definition.routes],
      adapter: target.definition.adapter,
      receive: target.definition.receive,
    };
    const fn = createCrossChannelToFn(makeRuntime(), [target.target]);

    await fn(duplicateDefinition, {}).send("ping", { auth: null });

    expect(target.receive).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicated compiled channel references with ambiguous route fingerprints", async () => {
    const first = makeChannel("first");
    const second = makeChannel("second");
    const duplicateDefinition: CompiledChannel = {
      __kind: CHANNEL_SENTINEL,
      routes: [{ method: "POST", path: "/same", handler: async () => new Response("ok") }],
      adapter: first.definition.adapter,
      receive: first.definition.receive,
    };
    first.target = { ...first.target, definition: duplicateDefinition };
    second.target = { ...second.target, definition: duplicateDefinition };
    const fn = createCrossChannelToFn(makeRuntime(), [first.target, second.target]);

    expect(() => fn({ ...duplicateDefinition }, {})).toThrow(
      /matches multiple registered channels by route shape/,
    );
  });

  it("throws when the passed channel is not registered in this agent", async () => {
    const slack = makeChannel("slack");
    const stranger = makeChannel("stranger");
    const fn = createCrossChannelToFn(makeRuntime(), [slack.target]);

    expect(() => fn(stranger.definition, {})).toThrow(/not registered in this agent's channels/);
  });

  it("throws when the target channel has no receive()", async () => {
    const slack = makeChannel("slack");
    slack.target = { ...slack.target, receive: undefined };
    const fn = createCrossChannelToFn(makeRuntime(), [slack.target]);

    await expect(fn(slack.definition, {}).send("x", { auth: null })).rejects.toThrow(
      /does not implement receive/,
    );
  });

  it("throws when the target channel has no adapter", async () => {
    const slack = makeChannel("slack");
    slack.target = { ...slack.target, adapter: undefined };
    const fn = createCrossChannelToFn(makeRuntime(), [slack.target]);

    await expect(fn(slack.definition, {}).send("x", { auth: null })).rejects.toThrow(/no adapter/);
  });

  it("forwards auth to the target receive verbatim", async () => {
    const slack = makeChannel("slack");
    const fn = createCrossChannelToFn(makeRuntime(), [slack.target]);
    const auth = {
      attributes: { incidentReference: "INC-42" },
      authenticator: "incidentio",
      principalId: "actor",
      principalType: "service" as const,
    };

    await fn(slack.definition, {}).send("go", { auth });

    expect(slack.receive.mock.calls[0]![0]).toEqual(expect.objectContaining({ auth }));
  });
});

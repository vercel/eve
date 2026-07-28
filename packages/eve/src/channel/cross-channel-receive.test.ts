import { describe, expect, it, vi } from "vitest";

import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import {
  createCrossChannelReceiveFn,
  type CrossChannelTarget,
} from "#channel/cross-channel-receive.js";
import type { Session } from "#channel/session.js";
import type { Runtime } from "#channel/types.js";

function makeRuntime(): Runtime {
  return {
    cancelTurn: vi.fn(),
    deliver: vi.fn(),
    getEventStream: vi.fn(),
    run: vi.fn(),
  };
}

function makeSession(): Session {
  return {
    id: "sess_1",
    continuationToken: "tok",
    async getEventStream() {
      return new ReadableStream();
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

describe("createCrossChannelReceiveFn", () => {
  it("delegates to the target channel's receive with a per-target send", async () => {
    const slack = makeChannel("slack");
    const fn = createCrossChannelReceiveFn(makeRuntime(), [slack.target]);

    const session = await fn(slack.definition, {
      message: "hello",
      target: { channelId: "C1" },
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
    expect(typeof ctx.send).toBe("function");
  });

  it("resolves the target by reference identity even when multiple channels are registered", async () => {
    const slack = makeChannel("slack");
    const twilio = makeChannel("twilio");
    const fn = createCrossChannelReceiveFn(makeRuntime(), [slack.target, twilio.target]);

    await fn(twilio.definition, { message: "ping", target: {}, auth: null });

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
    const fn = createCrossChannelReceiveFn(makeRuntime(), [target.target]);

    await fn(duplicateDefinition, { message: "ping", target: {}, auth: null });

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
    const fn = createCrossChannelReceiveFn(makeRuntime(), [first.target, second.target]);

    await expect(
      fn({ ...duplicateDefinition }, { message: "ping", target: {}, auth: null }),
    ).rejects.toThrow(/matches multiple registered channels by route shape/);
  });

  it("throws when the passed channel is not registered in this agent", async () => {
    const slack = makeChannel("slack");
    const stranger = makeChannel("stranger");
    const fn = createCrossChannelReceiveFn(makeRuntime(), [slack.target]);

    await expect(fn(stranger.definition, { message: "x", target: {}, auth: null })).rejects.toThrow(
      /not registered in this agent's channels/,
    );
  });

  it("throws when the target channel has no receive()", async () => {
    const slack = makeChannel("slack");
    slack.target = { ...slack.target, receive: undefined };
    const fn = createCrossChannelReceiveFn(makeRuntime(), [slack.target]);

    await expect(fn(slack.definition, { message: "x", target: {}, auth: null })).rejects.toThrow(
      /does not implement receive/,
    );
  });

  it("throws when the target channel has no adapter", async () => {
    const slack = makeChannel("slack");
    slack.target = { ...slack.target, adapter: undefined };
    const fn = createCrossChannelReceiveFn(makeRuntime(), [slack.target]);

    await expect(fn(slack.definition, { message: "x", target: {}, auth: null })).rejects.toThrow(
      /no adapter/,
    );
  });

  it("forwards auth to the target receive verbatim", async () => {
    const slack = makeChannel("slack");
    const fn = createCrossChannelReceiveFn(makeRuntime(), [slack.target]);
    const auth = {
      attributes: { incidentReference: "INC-42" },
      authenticator: "incidentio",
      principalId: "actor",
      principalType: "service" as const,
    };

    await fn(slack.definition, { message: "go", target: {}, auth });

    expect(slack.receive.mock.calls[0]![0]).toEqual(expect.objectContaining({ auth }));
  });
});

import { describe, expect, it, vi } from "vitest";

import { createChannelRouteArgs, type ChannelRoutePorts } from "#channel/route-args.js";
import type { Runtime } from "#channel/types.js";
import {
  readAgentInfoRouteResponse,
  readHomeRouteMetadata,
  readRemoteAgentStreamHeadersResolver,
  readRouteChannelName,
  readRouteSessionCreator,
  readSkillFileSource,
} from "#internal/nitro/routes/channel-route-context.js";

/** A runtime whose only member in use is `createSession`. */
function runtimeWith(createSession: Runtime["createSession"]): Runtime {
  return new Proxy<Runtime>(Object.create(null), {
    get: (_target, key) =>
      key === "createSession"
        ? createSession
        : () => {
            throw new Error(`Runtime.${String(key)} is unused here.`);
          },
  });
}

function ports(createSession: Runtime["createSession"]): ChannelRoutePorts {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    adapter: { kind: "http" },
    agent: {
      describe: unused,
      invokeTool: unused,
      listSkillFiles: unused,
      readSkill: unused,
    },
    agentInfo: async () => Response.json({ ok: true }),
    agentName: "weather",
    deliverySource: { channelKind: "http", channelName: "eve", requestId: "req_1" },
    params: { sessionId: "s_1" },
    requestIp: null,
    runtime: runtimeWith(createSession),
    to: () => {
      throw new Error("unused");
    },
    waitUntil: () => {},
  };
}

describe("createChannelRouteArgs", () => {
  it("creates sessions with the channel's namespaced token, its delivery id and request id", async () => {
    const createSession = vi.fn<Runtime["createSession"]>(async () => ({
      events: new ReadableStream(),
      sessionId: "s_1",
    }));
    const args = createChannelRouteArgs(ports(createSession));

    const created = await readRouteSessionCreator(args)?.({
      auth: null,
      continuationToken: "thread-1",
      deliveryId: "delivery_1",
      input: { message: "hi" },
    });

    expect(created).toMatchObject({ deliveryId: "delivery_1", sessionId: "s_1" });
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({
      adapter: { kind: "http" },
      channelName: "eve",
      continuationToken: "eve:thread-1",
      delivery: { channelKind: "http", channelName: "eve", deliveryId: "delivery_1" },
      requestId: "req_1",
    });
  });

  it("attaches what eve's own channels read, and only the optional fields the host has", async () => {
    const args = createChannelRouteArgs(ports(vi.fn()));

    expect(readRouteChannelName(args)).toBe("eve");
    expect(readHomeRouteMetadata(args)).toEqual({ agentName: "weather" });
    expect(await (await readAgentInfoRouteResponse(args)?.())?.json()).toEqual({ ok: true });
    expect(args.params).toEqual({ sessionId: "s_1" });
    expect(readSkillFileSource(args)).toBeUndefined();
    expect(readRemoteAgentStreamHeadersResolver(args)).toBeUndefined();
  });
});

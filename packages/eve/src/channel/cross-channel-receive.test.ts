import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import {
  createCrossChannelReceiveFn,
  type CrossChannelTarget,
} from "#channel/cross-channel-receive.js";
import type { Session } from "#channel/session.js";
import type { RunHandle, Runtime } from "#channel/types.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

function makeRuntime(): Runtime {
  return {
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

function makeRunHandle(): RunHandle {
  return {
    continuationToken: "target:thread",
    events: new ReadableStream<HandleMessageStreamEvent>(),
    sessionId: "new-session-id",
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

function makeForwardingChannel(name: string, channelOutputSchema?: { readonly type: string }) {
  type ReceiveFn = NonNullable<CompiledChannel["receive"]>;
  const receive = vi.fn<ReceiveFn>(async (input, { send }) =>
    send(
      channelOutputSchema === undefined
        ? input.message
        : { message: input.message, outputSchema: channelOutputSchema },
      {
        auth: input.auth,
        continuationToken: "thread",
      },
    ),
  );
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

  it("normalizes and injects Standard JSON Schema when resuming a session", async () => {
    const normalizedSchema = {
      additionalProperties: false,
      properties: { summary: { type: "string" } },
      required: ["summary"],
      type: "object",
    } as const;
    const inputConverter = vi.fn(() => ({ type: "string" }));
    const outputConverter = vi.fn(() => normalizedSchema);
    const outputSchema: StandardJSONSchemaV1 = {
      "~standard": {
        jsonSchema: { input: inputConverter, output: outputConverter },
        vendor: "test",
        version: 1,
      },
    };
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "existing-session-id" });
    const target = makeForwardingChannel("target");
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await fn(target.definition, {
      auth: null,
      message: "assess this",
      outputSchema,
      target: {},
    });

    expect(outputConverter).toHaveBeenCalledWith({ target: "draft-07" });
    expect(inputConverter).not.toHaveBeenCalled();
    expect(target.receive.mock.calls[0]![0]).toEqual({
      auth: null,
      message: "assess this",
      target: {},
    });
    expect(vi.mocked(runtime.deliver).mock.calls[0]![0].payload.outputSchema).toEqual(
      normalizedSchema,
    );
  });

  it("accepts and normalizes a Zod schema through the public receive type", async () => {
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "existing-session-id" });
    const target = makeForwardingChannel("target");
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await fn(target.definition, {
      auth: null,
      message: "assess this",
      outputSchema: z.object({
        summary: z.string(),
        verdict: z.enum(["approve", "reject"]),
      }),
      target: {},
    });

    expect(vi.mocked(runtime.deliver).mock.calls[0]![0].payload.outputSchema).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        verdict: { enum: ["approve", "reject"], type: "string" },
      },
      required: ["summary", "verdict"],
      type: "object",
    });
  });

  it("rejects unsupported Standard JSON Schema before invoking the target receive hook", async () => {
    const outputSchema: StandardJSONSchemaV1 = {
      "~standard": {
        jsonSchema: {
          input: () => ({ type: "object" }),
          output: () => {
            throw new Error("draft-07 output conversion is unsupported");
          },
        },
        vendor: "test",
        version: 1,
      },
    };
    const runtime = makeRuntime();
    const target = makeChannel("target");
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await expect(
      fn(target.definition, {
        auth: null,
        message: "assess this",
        outputSchema,
        target: {},
      }),
    ).rejects.toThrow("draft-07 output conversion is unsupported");

    expect(target.receive).not.toHaveBeenCalled();
    expect(runtime.deliver).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("injects a raw output schema when starting a new session", async () => {
    const outputSchema = {
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      type: "object",
    } as const;
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockRejectedValue(new RuntimeNoActiveSessionError("target:thread"));
    vi.mocked(runtime.run).mockResolvedValue(makeRunHandle());
    const target = makeForwardingChannel("target");
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await fn(target.definition, {
      auth: null,
      message: "assess this",
      outputSchema,
      target: {},
    });

    expect(vi.mocked(runtime.run).mock.calls[0]![0]).toMatchObject({
      continuationToken: "target:thread",
      input: { message: "assess this", outputSchema },
      mode: "conversation",
    });
  });

  it("injects a raw output schema when resuming a session", async () => {
    const outputSchema = {
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      type: "object",
    } as const;
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "existing-session-id" });
    const target = makeForwardingChannel("target");
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await fn(target.definition, {
      auth: null,
      message: "retry this assessment",
      outputSchema,
      target: {},
    });

    expect(vi.mocked(runtime.deliver).mock.calls[0]![0]).toMatchObject({
      continuationToken: "target:thread",
      payload: { message: "retry this assessment", outputSchema },
    });
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("overrides a target channel's send schema with the outer schema", async () => {
    const channelSchema = { type: "string" } as const;
    const outputSchema = { type: "object" } as const;
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "existing-session-id" });
    const target = makeForwardingChannel("target", channelSchema);
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await fn(target.definition, { auth: null, message: "assess this", outputSchema, target: {} });

    expect(vi.mocked(runtime.deliver).mock.calls[0]![0].payload.outputSchema).toEqual(outputSchema);
  });

  it("preserves a target channel's send schema when no outer schema is provided", async () => {
    const channelSchema = { type: "string" } as const;
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "existing-session-id" });
    const target = makeForwardingChannel("target", channelSchema);
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await fn(target.definition, { auth: null, message: "plain", target: {} });

    expect(vi.mocked(runtime.deliver).mock.calls[0]![0].payload.outputSchema).toEqual(
      channelSchema,
    );
  });

  it("keeps schemas isolated between concurrent receive invocations", async () => {
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "existing-session-id" });
    const target = makeForwardingChannel("target");
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);
    const firstSchema = { properties: { first: { type: "string" } }, type: "object" } as const;
    const secondSchema = { properties: { second: { type: "number" } }, type: "object" } as const;

    await Promise.all([
      fn(target.definition, {
        auth: null,
        message: "first",
        outputSchema: firstSchema,
        target: {},
      }),
      fn(target.definition, {
        auth: null,
        message: "second",
        outputSchema: secondSchema,
        target: {},
      }),
    ]);

    const payloads = vi.mocked(runtime.deliver).mock.calls.map(([input]) => input.payload);
    expect(payloads).toEqual([
      expect.objectContaining({ message: "first", outputSchema: firstSchema }),
      expect.objectContaining({ message: "second", outputSchema: secondSchema }),
    ]);
  });

  it("does not carry an outer schema into a later schema-free receive", async () => {
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "existing-session-id" });
    const target = makeForwardingChannel("target");
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await fn(target.definition, {
      auth: null,
      message: "structured",
      outputSchema: { type: "object" },
      target: {},
    });
    await fn(target.definition, { auth: null, message: "plain", target: {} });

    expect(vi.mocked(runtime.deliver).mock.calls[0]![0].payload.outputSchema).toEqual({
      type: "object",
    });
    expect(vi.mocked(runtime.deliver).mock.calls[1]![0].payload.outputSchema).toBeUndefined();
  });

  it("injects the outer schema into structured user content", async () => {
    const outputSchema = { type: "object" } as const;
    const message = [{ text: "inspect this image", type: "text" as const }];
    const runtime = makeRuntime();
    vi.mocked(runtime.deliver).mockResolvedValue({ sessionId: "existing-session-id" });
    const target = makeForwardingChannel("target");
    const fn = createCrossChannelReceiveFn(runtime, [target.target]);

    await fn(target.definition, {
      auth: null,
      message,
      outputSchema,
      target: {},
    });

    expect(vi.mocked(runtime.deliver).mock.calls[0]![0].payload).toMatchObject({
      message,
      outputSchema,
    });
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

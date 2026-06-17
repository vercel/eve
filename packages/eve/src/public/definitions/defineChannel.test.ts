import { describe, expect, it } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import type { InferReceiveTarget } from "#channel/receive-target.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { ContextAccessor } from "#context/key.js";
import { SessionKey, type Session } from "#context/keys.js";
import type { slackChannel, SlackInstrumentationMetadata } from "#public/channels/slack/index.js";
import type {
  twilioChannel,
  TwilioInstrumentationMetadata,
} from "#public/channels/twilio/index.js";
import {
  POST,
  WS,
  defineChannel,
  type InferChannelMetadata,
} from "#public/definitions/defineChannel.js";

type IsEqual<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
    ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
      ? true
      : false
    : false;

type Assert<T extends true> = T;

/**
 * `defineChannel` returns a `CompiledChannel`. Tests narrow through it
 * to validate the underlying adapter the registry will receive.
 */
function getAdapter(channel: unknown): ChannelAdapter<any> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected a CompiledChannel from defineChannel().");
  }
  return channel.adapter;
}

describe("defineChannel", () => {
  it("returns the bare passthrough adapter when nothing is configured", () => {
    const channel = defineChannel({ routes: [POST("/x", async () => new Response("ok"))] });

    const adapter = getAdapter(channel);
    expect(adapter.kind).toBe("http");
    expect(adapter.fetchFile).toBeUndefined();
  });

  it("declares websocket routes with an eve-owned route discriminator", () => {
    const channel = defineChannel({
      routes: [
        WS("/ws", () => ({
          message(peer, message) {
            peer.send(message.text());
          },
        })),
      ],
    });

    expect(channel.routes).toHaveLength(1);
    expect(channel.routes[0]).toMatchObject({
      method: "WEBSOCKET",
      path: "/ws",
      transport: "websocket",
    });
  });

  it("puts a declared fetchFile on the built adapter", () => {
    const fetchFile = async (_url: string) => {
      return Buffer.from("hello");
    };

    const channel = defineChannel({
      routes: [POST("/x", async () => new Response("ok"))],
      fetchFile,
    });

    const adapter = getAdapter(channel);
    expect(adapter.fetchFile).toBe(fetchFile);
  });

  it("escapes the bare-passthrough fast path when only fetchFile is declared", () => {
    // fetchFile counts as behavior, so the adapter must be
    // registered under a non-framework kind for the staging layer to
    // reach it.
    const fetchFile = async (_url: string) => {
      return Buffer.alloc(0);
    };

    const channel = defineChannel({
      routes: [POST("/x", async () => new Response("ok"))],
      fetchFile,
    });

    const adapter = getAdapter(channel);
    expect(adapter.kind).toBe("defineChannel");
    expect(adapter.fetchFile).toBe(fetchFile);
  });

  it("types and attaches channel metadata projections", () => {
    interface State {
      readonly threadTs: string | null;
    }
    type Metadata = {
      readonly threadTs: string | null;
    };

    const channel = defineChannel<State, void, Record<string, unknown>, Metadata>({
      state: { threadTs: null },
      routes: [POST("/x", async () => new Response("ok"))],
      metadata(state): Metadata {
        return { threadTs: state.threadTs };
      },
    });

    const adapter = getAdapter(channel);
    expect(adapter.kind).toBe("defineChannel");
    expect(adapter.instrumentation?.metadata?.(adapter.state)).toEqual({ threadTs: null });
  });

  it("infers channel metadata from metadata() return values", () => {
    const channel = defineChannel({
      state: { threadTs: null as string | null },
      routes: [POST("/x", async () => new Response("ok"))],
      metadata(state) {
        return {
          threadTs: state.threadTs,
          source: "support" as const,
        };
      },
    });

    type Metadata = InferChannelMetadata<typeof channel>;
    const metadata: Metadata = { threadTs: "123.456", source: "support" };
    // @ts-expect-error threadTs is inferred from the metadata() return type.
    const invalid: Metadata = { threadTs: 123, source: "support" };
    void metadata;
    void invalid;
  });

  it("infers state, context, and metadata without explicit channel generics", () => {
    type State = { readonly completedTurns: number };

    const channel = defineChannel({
      state: { completedTurns: 0 },
      context(state) {
        return { state };
      },
      routes: [
        POST<State>("/x", async (_request, { send }) => {
          await send("hello", {
            auth: null,
            continuationToken: "x",
            state: { completedTurns: 1 },
          });
          await send("hello", {
            auth: null,
            continuationToken: "x",
            // @ts-expect-error route send state is inferred from defineChannel state.
            state: { completedTurns: "1" },
          });

          return new Response("ok");
        }),
      ],
      metadata(state) {
        return { turnCount: state.completedTurns };
      },
      events: {
        "message.completed"(_event, channel) {
          const turnCount: number = channel.state.completedTurns;
          void turnCount;
        },
      },
    });

    type Metadata = InferChannelMetadata<typeof channel>;
    const metadata: Metadata = { turnCount: 1 };
    // @ts-expect-error metadata is inferred from metadata(), not open.
    const invalid: Metadata = { turnCount: "1" };
    void metadata;
    void invalid;
  });

  it("falls back to open metadata for channels without metadata()", () => {
    const channel = defineChannel({
      routes: [POST("/x", async () => new Response("ok"))],
    });

    const metadata: InferChannelMetadata<typeof channel> = { anyKey: "any value" };
    void metadata;
  });

  it("preserves wrapper metadata on Slack and Twilio channel return types", () => {
    type SlackMetadata = InferChannelMetadata<ReturnType<typeof slackChannel>>;
    type TwilioMetadata = InferChannelMetadata<ReturnType<typeof twilioChannel>>;
    type SlackAssertion = Assert<IsEqual<SlackMetadata, SlackInstrumentationMetadata>>;
    type TwilioAssertion = Assert<IsEqual<TwilioMetadata, TwilioInstrumentationMetadata>>;

    const assertions: [SlackAssertion, TwilioAssertion] = [true, true];
    void assertions;
  });

  it("type-checks channel metadata projections against the declared shape", () => {
    interface State {
      readonly threadTs: string | null;
    }
    type Metadata = {
      readonly threadTs: string | null;
    };

    defineChannel<State, void, Record<string, unknown>, Metadata>({
      state: { threadTs: null },
      routes: [POST("/x", async () => new Response("ok"))],
      metadata(state): Metadata {
        return {
          // @ts-expect-error threadTs must match the declared metadata type.
          threadTs: state.threadTs === null ? 1 : state.threadTs,
        };
      },
    });
  });

  it("preserves state + context + events when fetchFile is also declared", () => {
    const fetchFile = async (_url: string) => {
      return Buffer.alloc(0);
    };

    interface State {
      readonly turnId: string | null;
    }

    const channel = defineChannel<State>({
      state: { turnId: null },
      routes: [POST("/x", async () => new Response("ok"))],
      fetchFile,
    });

    const adapter = getAdapter(channel);
    expect(adapter.kind).toBe("defineChannel");
    expect(adapter.state).toEqual({ turnId: null });
    expect(typeof adapter.deliver).toBe("function");
    expect(typeof adapter.createAdapterContext).toBe("function");
    expect(adapter.fetchFile).toBe(fetchFile);
  });

  it("honors kindHint on the bare-passthrough fast path", () => {
    const channel = defineChannel({
      kindHint: "slack",
      routes: [POST("/x", async () => new Response("ok"))],
    });

    const adapter = getAdapter(channel);
    expect(adapter.kind).toBe("slack");
  });

  it("honors kindHint on the full-behavior adapter", () => {
    interface State {
      readonly turnId: string | null;
    }

    const channel = defineChannel<State>({
      kindHint: "slack",
      state: { turnId: null },
      routes: [POST("/x", async () => new Response("ok"))],
    });

    const adapter = getAdapter(channel);
    expect(adapter.kind).toBe("slack");
  });

  it("hands the live SessionHandle to the context() factory and exposes it on ctx.session", () => {
    interface State {
      readonly threadTs: string | null;
    }

    const captured: { sessions: Array<{ setContinuationToken: (t: string) => void }> } = {
      sessions: [],
    };
    const channel = defineChannel<State, { state: State }>({
      kindHint: "slack",
      state: { threadTs: null },
      routes: [POST("/x", async () => new Response("ok"))],
      context(state, session) {
        captured.sessions.push(session);
        return { state };
      },
    });

    const adapter = getAdapter(channel);

    // Stand up a minimal accessor whose `set` calls are captured so the
    // session handle's `setContinuationToken` is observable.
    const writes: Array<[string, unknown]> = [];
    let continuationToken = "slack:C123:";
    const accessor: ContextAccessor = {
      get: <T>(key: { name: string }): T | undefined =>
        key.name === "eve.continuationToken" ? (continuationToken as T) : undefined,
      has: () => false,
      require: () => {
        throw new Error("not implemented in test");
      },
      set: <T>(key: { name: string }, value: T | ((current: T | undefined) => T)): T => {
        const next =
          typeof value === "function" ? (value as (c: T | undefined) => T)(undefined) : value;
        if (key.name === "eve.continuationToken") {
          continuationToken = String(next);
        }
        writes.push([key.name, next]);
        return next;
      },
      ensure: <T>(key: { name: string }, create: () => T): T => {
        const next = create();
        writes.push([key.name, next]);
        return next;
      },
    };

    const adapterCtx = buildAdapterContext(adapter, accessor) as { session: unknown };

    expect(captured.sessions).toHaveLength(1);
    // The session is the one ctx.session exposes (same reference).
    expect(adapterCtx.session).toBe(captured.sessions[0]);

    captured.sessions[0]!.setContinuationToken("C123:T456");
    expect(writes).toEqual([["eve.continuationToken", "slack:C123:T456"]]);
  });

  it("passes SessionContext as third arg to event handlers inside the ALS scope", async () => {
    let capturedChannel: any;
    let capturedCtx: any;
    const channel = defineChannel({
      routes: [POST("/x", async () => new Response("ok"))],
      events: {
        "turn.started": (_data, ch, ctx) => {
          capturedChannel = ch;
          capturedCtx = ctx;
        },
      },
    });

    const adapter = getAdapter(channel);

    const session: Session = {
      auth: { current: null, initiator: null },
      sessionId: "sess-channel-test",
      turn: { id: "turn-1", sequence: 0 },
    };
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);

    const accessor: ContextAccessor = {
      get: (key) => ctx.get(key as any),
      has: (key) => ctx.has(key as any),
      require: (key) => ctx.require(key as any),
      set: (key, value) => ctx.set(key as any, value),
      ensure: (key, create) => ctx.ensure(key as any, create),
    };

    const adapterCtx = buildAdapterContext(adapter, accessor);

    await contextStorage.run(ctx, async () => {
      await callAdapterEventHandler(adapter, { type: "turn.started" } as any, adapterCtx);
    });

    expect(capturedCtx).toBeDefined();
    expect(typeof capturedCtx.getSandbox).toBe("function");
    expect(typeof capturedCtx.getSkill).toBe("function");
    expect(capturedCtx.session.id).toBe("sess-channel-test");
    expect(capturedCtx.session.turn).toEqual({ id: "turn-1", sequence: 0 });
    expect(typeof capturedChannel.continuationToken).toBe("string");
    expect(typeof capturedChannel.setContinuationToken).toBe("function");
  });

  it("session.failed handler receives no ctx parameter", async () => {
    let called = false;
    let argCount = 0;
    const channel = defineChannel({
      routes: [POST("/x", async () => new Response("ok"))],
      events: {
        "session.failed": (...args) => {
          called = true;
          argCount = args.length;
        },
      },
    });

    const adapter = getAdapter(channel);

    const accessor: ContextAccessor = {
      get: () => undefined,
      has: () => false,
      require: () => {
        throw new Error("not in scope");
      },
      set: (_key: any, value: any) => value,
      ensure: (_key: any, create: () => any) => create(),
    };

    const adapterCtx = buildAdapterContext(adapter, accessor);

    await callAdapterEventHandler(
      adapter,
      {
        type: "session.failed",
        data: { code: "INTERNAL", message: "boom", sessionId: "sess-1" },
      },
      adapterCtx,
    );

    expect(called).toBe(true);
    expect(argCount).toBe(2);
  });

  it("advertises typed cross-channel receive targets from raw defineChannel", () => {
    interface ReceiveTarget {
      readonly channelId: string;
      readonly threadTs?: string;
    }

    const channel = defineChannel<undefined, void, ReceiveTarget>({
      routes: [POST("/x", async () => new Response("ok"))],
      async receive(input) {
        const channelId: string = input.target.channelId;
        const threadTs: string | undefined = input.target.threadTs;
        // @ts-expect-error receive targets are the authored shape, not an open record.
        const missing = input.target.missing;
        void missing;
        void threadTs;

        return {
          id: channelId,
          continuationToken: channelId,
          async getEventStream() {
            return new ReadableStream();
          },
        };
      },
    });

    type ChannelReceiveTarget = InferReceiveTarget<typeof channel>;
    const target: ChannelReceiveTarget = { channelId: "C123" };
    // @ts-expect-error channelId is required by the channel's receive target.
    const missing: ChannelReceiveTarget = {};
    void target;
    void missing;
  });
});

import { describe, expect, it, vi } from "vitest";

import { defineInstructions } from "#public/definitions/instructions.js";

vi.mock("#context/build-callback-context.js", () => ({
  buildCallbackContext: () => ({
    session: { id: "test", auth: { current: null, initiator: null }, turn: {} },
  }),
}));

const { dispatchDynamicInstructionEvent, buildDynamicInstructionMessages } =
  await import("#context/dynamic-instruction-lifecycle.js");

import { ContextContainer } from "#context/container.js";
import {
  SessionDynamicInstructionsKey,
  TurnDynamicInstructionsKey,
  SessionIdKey,
} from "#context/keys.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

function createResolver(
  slug: string,
  eventNames: readonly string[],
  handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>,
): ResolvedDynamicInstructionsResolver {
  const events: Record<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>> = {};
  for (const name of eventNames) {
    events[name] = handler;
  }
  return {
    slug,
    eventNames,
    events,
    sourceId: `test:${slug}`,
    sourceKind: "module",
    logicalPath: `agent/instructions/${slug}.ts`,
  };
}

function createCtx(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "test-session");
  return ctx;
}

function makeEvent(type: string): HandleMessageStreamEvent {
  return { type, data: {} } as HandleMessageStreamEvent;
}

describe("dispatchDynamicInstructionEvent", () => {
  it("stores session-scoped instructions on durable key", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started"], () =>
      defineInstructions({ markdown: "You are a helpful assistant." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(ctx.get(SessionDynamicInstructionsKey)).toEqual({
      context: [{ role: "system", content: "You are a helpful assistant." }],
    });
    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "You are a helpful assistant." },
    ]);
  });

  it("stores turn-scoped instructions on turn durable key", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["turn.started"], () =>
      defineInstructions({ markdown: "Turn context." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(ctx.get(TurnDynamicInstructionsKey)).toEqual({
      context: [{ role: "system", content: "Turn context." }],
    });
  });

  it("skips resolvers that do not match the event type", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => defineInstructions({ markdown: "nope" }));
    const resolver = createResolver("context", ["session.started"], handler);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("skips null returns without error", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started"], () => null);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("logs and skips unbranded return values", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started"], () => ({
      markdown: "not branded",
    }));

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("logs and skips throwing resolvers", async () => {
    const ctx = createCtx();
    const resolver = createResolver("broken", ["session.started"], () => {
      throw new Error("resolver exploded");
    });

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("unions messages from different resolver slugs", async () => {
    const ctx = createCtx();
    const r1 = createResolver("a", ["turn.started"], () =>
      defineInstructions({ markdown: "From A." }),
    );
    const r2 = createResolver("b", ["turn.started"], () =>
      defineInstructions({ markdown: "From B." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [r1, r2],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "From A." },
      { role: "system", content: "From B." },
    ]);
  });

  it("replaces messages from the same resolver slug on re-dispatch", async () => {
    const ctx = createCtx();
    let version = "v1";
    const resolver = createResolver("context", ["turn.started"], () =>
      defineInstructions({ markdown: version }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([{ role: "system", content: "v1" }]);

    version = "v2";
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([{ role: "system", content: "v2" }]);
  });

  it("null return clears the resolver's slot", async () => {
    const ctx = createCtx();
    let enabled = true;
    const resolver = createResolver("context", ["turn.started"], () =>
      enabled ? defineInstructions({ markdown: "Instructions." }) : null,
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toHaveLength(1);

    enabled = false;
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
    expect(ctx.get(TurnDynamicInstructionsKey)).toEqual({});
  });

  it("session instructions survive step boundary (durable)", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started"], () =>
      defineInstructions({ markdown: "Session context." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    // Simulate step boundary: clear virtual context.
    ctx.clearVirtualContext();

    // Durable key survives — buildDynamicInstructionMessages reads from durable.
    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "Session context." },
    ]);
  });

  it("session + turn instructions are ordered session first", async () => {
    const ctx = createCtx();
    const sessionResolver = createResolver("session-ctx", ["session.started"], () =>
      defineInstructions({ markdown: "Session." }),
    );
    const turnResolver = createResolver("turn-ctx", ["turn.started"], () =>
      defineInstructions({ markdown: "Turn." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [sessionResolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [turnResolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "Session." },
      { role: "system", content: "Turn." },
    ]);
  });

  it("rejects step.started events for instructions", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => defineInstructions({ markdown: "nope" }));
    const resolver = createResolver("context", ["step.started"], handler);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores events outside the allowed set", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => defineInstructions({ markdown: "nope" }));
    const resolver = createResolver("context", ["message.completed"], handler);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("message.completed"),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("stores durable messages that survive serialization", async () => {
    const ctx = createCtx();
    const resolver = createResolver("ctx", ["session.started"], () =>
      defineInstructions({ markdown: "Durable." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const serializedKeys = [...ctx.entries()].map(([key]) => key.name);
    expect(serializedKeys).toContain("eve.sessionDynamicInstructions");
  });
});

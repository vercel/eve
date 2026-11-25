import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  buildCallbackContext,
  sandboxOf,
  withRuntimeSandboxLifecycle,
} from "#context/build-callback-context.js";
import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionKey } from "#context/keys.js";
import type { GetSandboxOptions, SessionContext } from "#context/session-context.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { VercelSandbox, type VercelSandboxSession } from "#public/sandbox/vercel.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { ConversationContextKey, type ConversationContext } from "#shared/conversation-context.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";

describe("buildCallbackContext", () => {
  function contextWith(conversation?: ConversationContext): ContextContainer {
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });
    if (conversation !== undefined) ctx.set(ConversationContextKey, conversation);
    return ctx;
  }

  it("exposes the session's conversation, including its space", () => {
    const conversation: ConversationContext = {
      audience: "private",
      channel: { kind: "channel:slack", name: "slack" },
      environment: "production",
      principalType: "user",
      space: { id: "slack:T1:C1", type: "shared", workspaceId: "slack:T1" },
    };

    expect(
      contextStorage.run(contextWith(conversation), buildCallbackContext).conversation,
    ).toEqual(conversation);
  });

  it("omits the conversation when the session has none", () => {
    expect(contextStorage.run(contextWith(), buildCallbackContext)).not.toHaveProperty(
      "conversation",
    );
  });
});

describe("withRuntimeSandboxLifecycle", () => {
  it("preserves custom methods and private receivers on frozen provider sessions", async () => {
    class CustomSession {
      readonly #token = "custom-session-ok";
      probe() {
        return this.#token;
      }
    }
    const target = Object.freeze(new CustomSession());
    const deleteSandbox = vi.fn(async () => {});
    const stop = vi.fn(async () => {});

    const session = withRuntimeSandboxLifecycle(
      target as never,
      deleteSandbox,
      stop,
    ) as CustomSession & {
      delete(): Promise<void>;
      stop(): Promise<void>;
    };

    expect(session.probe()).toBe("custom-session-ok");
    await session.delete();
    await session.stop();
    expect(deleteSandbox).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("sandboxOf", () => {
  it("probes via getIfStarted without starting and returns null when unopened", async () => {
    const environment = VercelSandbox.environment();
    const otherEnvironment = VercelSandbox.environment();
    const { access, session } = mockSandbox();
    const get = vi.fn(access.get);
    let started = false;
    const getIfStarted = vi.fn(async () => (started ? session : null));
    const ctx = new ContextContainer();
    const probeAccess: SandboxAccess = {
      ...access,
      environment,
      get,
      getIfStarted,
    };
    ctx.set(SandboxKey, probeAccess);

    const getSandbox = sandboxOf(ctx);

    await expect(getSandbox({ create: false })).resolves.toBeNull();
    await expect(getSandbox(environment, { create: false })).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(getIfStarted).toHaveBeenCalledTimes(2);

    expect(() => getSandbox(otherEnvironment, { create: false })).toThrow(
      "The requested sandbox environment is not active for the current session.",
    );

    started = true;
    const live = await getSandbox(environment, { create: false });
    expect(live).not.toBeNull();
    expect(get).not.toHaveBeenCalled();

    const assertTypes = (sessionCtx: SessionContext, opts: GetSandboxOptions) => {
      expectTypeOf(sessionCtx.getSandbox()).toEqualTypeOf<Promise<RuntimeSandboxSession>>();
      expectTypeOf(sessionCtx.getSandbox({ create: true })).toEqualTypeOf<
        Promise<RuntimeSandboxSession>
      >();
      expectTypeOf(sessionCtx.getSandbox({ create: false })).toEqualTypeOf<
        Promise<RuntimeSandboxSession | null>
      >();
      expectTypeOf(sessionCtx.getSandbox(opts)).toEqualTypeOf<
        Promise<RuntimeSandboxSession | null>
      >();
      expectTypeOf(sessionCtx.getSandbox(environment)).toEqualTypeOf<
        Promise<RuntimeSandboxSession<VercelSandboxSession>>
      >();
      expectTypeOf(sessionCtx.getSandbox(environment, { create: true })).toEqualTypeOf<
        Promise<RuntimeSandboxSession<VercelSandboxSession>>
      >();
      expectTypeOf(sessionCtx.getSandbox(environment, { create: false })).toEqualTypeOf<
        Promise<RuntimeSandboxSession<VercelSandboxSession> | null>
      >();
      expectTypeOf(sessionCtx.getSandbox(environment, opts)).toEqualTypeOf<
        Promise<RuntimeSandboxSession<VercelSandboxSession> | null>
      >();
    };
    expectTypeOf(assertTypes).toBeFunction();
  });

  it("returns null from buildBaseToolContext.getSandbox({ create: false }) without binding an abort proxy, and binds once started", async () => {
    const { access, session } = mockSandbox();
    let started = false;
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });
    ctx.set(SandboxKey, {
      ...access,
      getIfStarted: async () => (started ? session : null),
    });

    await contextStorage.run(ctx, async () => {
      const toolCtx = buildBaseToolContext({
        options: { abortSignal: new AbortController().signal, toolCallId: "call-1" },
        toolName: "probe",
      });
      await expect(toolCtx.getSandbox({ create: false })).resolves.toBeNull();
      started = true;
      await expect(toolCtx.getSandbox({ create: false })).resolves.not.toBeNull();
    });
  });
});

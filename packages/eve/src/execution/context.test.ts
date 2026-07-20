import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { ensureContext, getContext, setContext } from "#context/accessors.js";
import { ContextContainer, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import {
  AuthKey,
  InitiatorAuthKey,
  ParentSessionKey,
  type SessionAuthContext,
  SessionIdKey,
  SessionKey,
} from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { runStep } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";

vi.mock("./sandbox/ensure.js", () => ({
  ensureSandboxAccess: vi.fn().mockResolvedValue({
    captureState: vi.fn().mockResolvedValue({ initialized: false, session: null }),
    get: vi.fn().mockResolvedValue(null),
  }),
}));

function createStubSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "sess-test",
    ...overrides,
  };
}

function createSessionWithEmissionState(input: {
  readonly state: HarnessEmissionState;
}): HarnessSession {
  return createStubSession({
    state: {
      "eve.harness.emission": input.state,
    },
  });
}

function createSeedContext(overrides?: {
  auth?: SessionAuthContext | null;
  channel?: ChannelAdapter;
  initiatorAuth?: SessionAuthContext | null;
  parent?: {
    readonly callId: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly turn: {
      readonly id: string;
      readonly sequence: number;
    };
  };
  sessionId?: string;
}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, overrides?.auth ?? null);
  ctx.set(ChannelKey, overrides?.channel ?? { kind: "http" });
  ctx.set(SessionIdKey, overrides?.sessionId ?? "sess-default");

  if (overrides?.initiatorAuth !== undefined) {
    ctx.set(InitiatorAuthKey, overrides.initiatorAuth);
  }

  if (overrides?.parent !== undefined) {
    ctx.set(ParentSessionKey, overrides.parent);
  }

  return ctx;
}

describe("runStep with sessionProvider", () => {
  it("builds a session with auth from durable context", async () => {
    const auth: SessionAuthContext = {
      attributes: { role: "admin" },
      authenticator: "jwt-hmac",
      principalId: "user-123",
      principalType: "user",
    };

    const ctx = createSeedContext({ auth, sessionId: "sess-xyz" });

    await runStep(ctx, createStubSession(), async () => {
      const session = loadContext().require(SessionKey);
      expect(session.auth).toEqual({ current: auth, initiator: auth });
      expect(session.sessionId).toBe("sess-xyz");
      expect(session.turn.id).toBe("turn_0");
      expect(session.turn.sequence).toBe(0);

      return { next: null, session: createStubSession() };
    });
  });

  it("preserves parent lineage and initiator auth overrides", async () => {
    const currentAuth: SessionAuthContext = {
      attributes: { role: "delegate" },
      authenticator: "jwt-hmac",
      principalId: "user-456",
      principalType: "user",
    };
    const initiatorAuth: SessionAuthContext = {
      attributes: { role: "owner" },
      authenticator: "jwt-hmac",
      principalId: "user-123",
      principalType: "user",
    };

    const ctx = createSeedContext({
      auth: currentAuth,
      initiatorAuth,
      parent: {
        callId: "call-parent",
        rootSessionId: "parent-session",
        sessionId: "parent-session",
        turn: {
          id: "parent-turn",
          sequence: 7,
        },
      },
      sessionId: "child-session",
    });

    await runStep(ctx, createStubSession(), async () => {
      const session = loadContext().require(SessionKey);
      expect(session.auth).toEqual({
        current: currentAuth,
        initiator: initiatorAuth,
      });
      expect(session.parent).toEqual({
        callId: "call-parent",
        rootSessionId: "parent-session",
        sessionId: "parent-session",
        turn: {
          id: "parent-turn",
          sequence: 7,
        },
      });

      return { next: null, session: createStubSession() };
    });
  });

  it("derives stable turn metadata from harness emission state", async () => {
    const ctx = createSeedContext();
    const turns: Array<{ id: string; sequence: number }> = [];

    const stepInTurn = async (session: HarnessSession) => {
      await runStep(ctx, session, async () => {
        turns.push(loadContext().require(SessionKey).turn);
        return { next: null, session };
      });
    };

    await stepInTurn(
      createSessionWithEmissionState({
        state: {
          sequence: 2,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "turn_2",
        },
      }),
    );
    await stepInTurn(
      createSessionWithEmissionState({
        state: {
          sequence: 2,
          sessionStarted: true,
          stepIndex: 1,
          turnId: "turn_2",
        },
      }),
    );
    await stepInTurn(
      createSessionWithEmissionState({
        state: {
          sequence: 3,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "",
        },
      }),
    );

    expect(turns).toEqual([
      { id: "turn_2", sequence: 2 },
      { id: "turn_2", sequence: 2 },
      { id: "turn_3", sequence: 3 },
    ]);
  });
});

const TestCounterKey = new ContextKey<{ count: number }>("test.context.counter");
const TestCodecKey = new ContextKey<{ value: string }>("test.context.codec", {
  codec: {
    deserialize: (data) => {
      const raw = data as { encoded: string };
      return { value: raw.encoded };
    },
    serialize: (value) => ({ encoded: value.value }),
  },
});

describe("durable authored context", () => {
  it("ensureContext initializes once and does not overwrite an existing value", async () => {
    const ctx = createSeedContext();
    const session = createStubSession();
    ctx.set(TestCounterKey, { count: 4 });

    await runStep(ctx, session, async () => {
      const existing = ensureContext(TestCounterKey, () => ({ count: 0 }));
      expect(existing).toEqual({ count: 4 });
      expect(getContext(TestCounterKey)).toEqual({ count: 4 });
      return { next: null, session };
    });
  });

  it("setContext accepts an updater function", async () => {
    const ctx = createSeedContext();
    const session = createStubSession();
    ctx.set(TestCounterKey, { count: 7 });

    await runStep(ctx, session, async () => {
      setContext(TestCounterKey, (current) => ({ count: (current?.count ?? 0) + 1 }));
      expect(getContext(TestCounterKey)).toEqual({ count: 8 });
      return { next: null, session };
    });

    expect(ctx.require(TestCounterKey)).toEqual({ count: 8 });
  });

  it("serializes durable values across step boundaries", async () => {
    const ctx = createSeedContext();
    const session = createStubSession();

    await runStep(ctx, session, async () => {
      setContext(TestCodecKey, { value: "world" });
      return { next: null, session };
    });

    const serialized = serializeContext(ctx);
    expect(serialized[TestCodecKey.name]).toEqual({ encoded: "world" });
    delete serialized[ChannelKey.name];
    delete serialized[AuthKey.name];
    delete serialized[SessionIdKey.name];

    const deserialized = await deserializeContext(serialized);
    expect(deserialized.require(TestCodecKey)).toEqual({ value: "world" });
  });
});

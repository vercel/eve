import { describe, expect, it } from "vitest";
import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  type Session,
  type SessionAuthContext,
  SessionIdKey,
  SessionKey,
  SubagentMaxDepthKey,
} from "#context/keys.js";
import { buildRunContext } from "#execution/runtime-context.js";

function createTestSession(
  input: { readonly auth?: SessionAuthContext | null; readonly parent?: Session["parent"] } = {},
): Session {
  const auth = input.auth ?? null;

  return {
    auth: { current: auth, initiator: auth },
    parent: input.parent,
    sessionId: "sess-1",
    turn: { id: "turn-1", sequence: 0 },
  };
}

describe("contextStorage", () => {
  it("makes getSession() available inside the callback", () => {
    const session = createTestSession();
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);

    const result = contextStorage.run(ctx, () => loadContext().require(SessionKey));

    expect(result).toEqual(session);
  });

  it("provides auth through the session", () => {
    const auth: SessionAuthContext = {
      attributes: { role: "admin" },
      authenticator: "jwt-hmac",
      principalId: "user-42",
      principalType: "user",
    };

    const session = createTestSession({ auth });
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);

    const retrieved = contextStorage.run(ctx, () => loadContext().require(SessionKey));

    expect(retrieved.auth.current).toEqual(auth);
    expect(retrieved.auth.initiator).toEqual(auth);
  });

  it("provides null auth when no auth is set", () => {
    const session = createTestSession({ auth: null });
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);

    const retrieved = contextStorage.run(ctx, () => loadContext().require(SessionKey));

    expect(retrieved.auth.current).toBeNull();
    expect(retrieved.auth.initiator).toBeNull();
  });

  it("preserves parent lineage on the active session", () => {
    const session = createTestSession({
      parent: {
        callId: "call-parent",
        rootSessionId: "parent-session",
        sessionId: "parent-session",
        turn: {
          id: "parent-turn",
          sequence: 4,
        },
      },
    });
    const ctx = new ContextContainer();
    ctx.set(SessionKey, session);

    const retrieved = contextStorage.run(ctx, () => loadContext().require(SessionKey));

    expect(retrieved.parent).toEqual({
      callId: "call-parent",
      rootSessionId: "parent-session",
      sessionId: "parent-session",
      turn: {
        id: "parent-turn",
        sequence: 4,
      },
    });
  });
});

describe("loadContext", () => {
  it("throws when called outside of a context scope", () => {
    expect(() => loadContext()).toThrow("No active eve context");
  });
});

describe("ContextContainer", () => {
  it("returns undefined for unset keys via tryGetContext", () => {
    const ctx = new ContextContainer();
    expect(ctx.get(SessionKey)).toBeUndefined();
  });

  it("throws for unset keys via getContext", () => {
    const ctx = new ContextContainer();
    expect(() => ctx.require(SessionKey)).toThrow('Context key "eve.session" is not set.');
  });

  it("reports hasContext correctly", () => {
    const ctx = new ContextContainer();
    expect(ctx.has(SessionKey)).toBe(false);
    ctx.set(SessionKey, createTestSession());
    expect(ctx.has(SessionKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRunContext
// ---------------------------------------------------------------------------

const testAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

function createMinimalBundle(): Parameters<typeof buildRunContext>[0]["bundle"] {
  return {
    compiledArtifactsSource: {},
    graph: {
      nodesByNodeId: new Map(),
      root: {
        sandboxRegistry: { sandbox: null },
        turnAgent: { skills: [] },
      },
    },
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    toolRegistry: {},
    turnAgent: {},
  } as never;
}

describe("buildRunContext", () => {
  it("seeds auth from the run input", () => {
    const ctx = buildRunContext({
      bundle: createMinimalBundle(),
      run: {
        auth: testAuth,
        adapter: { kind: "http" },
        continuationToken: "t",
        input: { message: "hi" },
        mode: "conversation",
      },
    });

    expect(ctx.require(AuthKey)).toEqual(testAuth);
    expect(ctx.get(SessionIdKey)).toBeUndefined();
  });

  it("seeds null auth when the run input has null auth", () => {
    const ctx = buildRunContext({
      bundle: createMinimalBundle(),
      run: {
        auth: null,
        adapter: { kind: "http" },
        continuationToken: "t",
        input: { message: "hi" },
        mode: "conversation",
      },
    });

    expect(ctx.require(AuthKey)).toBeNull();
  });

  it("does not throw when channel has no onContext", () => {
    expect(() =>
      buildRunContext({
        bundle: createMinimalBundle(),
        run: {
          auth: null,
          adapter: { kind: "http" },
          continuationToken: "t",
          input: { message: "hi" },
          mode: "conversation",
        },
      }),
    ).not.toThrow();
  });

  it("does not seed SessionIdKey", () => {
    const ctx = buildRunContext({
      bundle: createMinimalBundle(),
      run: {
        auth: null,
        adapter: { kind: "http" },
        continuationToken: "t",
        input: { message: "hi" },
        mode: "conversation",
      },
    });

    expect(ctx.get(SessionIdKey)).toBeUndefined();
  });

  it("grafts parent metadata onto the child's own kind", () => {
    const parentProjection = {
      kind: "channel:slack",
      metadata: { threadTs: "1234.5678", userId: "U123" },
    };
    const ctx = buildRunContext({
      bundle: createMinimalBundle(),
      run: {
        auth: null,
        adapter: { kind: "subagent" },
        channelMetadata: parentProjection,
        continuationToken: "t",
        input: { message: "hi" },
        mode: "task",
      },
    });

    const result = ctx.get(ChannelInstrumentationKey)!;
    expect(result.kind).toBe("subagent");
    expect(result.metadata).toEqual({ threadTs: "1234.5678", userId: "U123" });
  });

  it("uses the adapter's own projection when channelMetadata is not provided", () => {
    const ctx = buildRunContext({
      bundle: createMinimalBundle(),
      run: {
        auth: null,
        adapter: { kind: "http" },
        continuationToken: "t",
        input: { message: "hi" },
        mode: "conversation",
      },
    });

    const projection = ctx.get(ChannelInstrumentationKey);
    expect(projection).toBeDefined();
    expect(projection!.kind).toBe("http");
    expect(projection!.metadata).toEqual({});
  });

  it("seeds inherited subagent max depth from the run input", () => {
    const ctx = buildRunContext({
      bundle: createMinimalBundle(),
      run: {
        auth: null,
        adapter: { kind: "subagent" },
        continuationToken: "t",
        input: { message: "hi" },
        mode: "task",
        subagentMaxDepth: 4,
      },
    });

    expect(ctx.require(SubagentMaxDepthKey)).toBe(4);
  });
});

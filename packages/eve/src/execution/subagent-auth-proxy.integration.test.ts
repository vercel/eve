import { describe, expect, it } from "vitest";

import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
} from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import { emitProxiedSubagentEvent } from "#execution/subagent-event-proxy-step.js";
import { projectToDurableSession } from "#execution/session.js";
import type { HarnessSession } from "#harness/types.js";
import type { TimedHandleMessageStreamEvent } from "#protocol/message.js";
import { deserializeRuntimeAdapter } from "#runtime/channels/registry.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";

interface AuthorizationAdapterState extends Record<string, unknown> {
  outcome?: string;
  pendingName?: string;
}

type AuthorizationAdapterContext = ChannelAdapterContext<AuthorizationAdapterState>;

const authorizationAdapter: ChannelAdapter<AuthorizationAdapterContext> = {
  kind: "authorization-proxy-test",
  "authorization.required"(data, ctx) {
    ctx.state.pendingName = data.name;
    ctx.session.setContinuationToken("auth-thread");
  },
  "authorization.completed"(data, ctx) {
    delete ctx.state.pendingName;
    ctx.state.outcome = data.outcome;
  },
};

const turnAgent = {
  id: "test-agent",
  instructions: ["You are a test agent."],
  model: { id: "test-model" },
  skills: [],
  tools: [],
  workspaceSpec: {} as never,
};

function buildBundle(adapter: ChannelAdapter): CompiledBundle {
  return {
    adapterRegistry: {
      adaptersByKind: new Map([[adapter.kind, adapter]]),
    },
    compiledArtifactsSource: {} as never,
    graph: {
      nodesByNodeId: new Map(),
      root: {
        sandboxRegistry: { sandbox: null },
        turnAgent,
      },
    },
    hookRegistry: createEmptyHookRegistry(),
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    toolRegistry: {},
    turnAgent,
  } as never;
}

function buildContext(input: { readonly adapter: ChannelAdapter; readonly sessionId: string }): {
  readonly bundle: ReturnType<typeof buildBundle>;
  readonly ctx: ContextContainer;
} {
  const bundle = buildBundle(input.adapter);
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, input.adapter);
  ctx.set(ContinuationTokenKey, "http:parent");
  ctx.set(SessionIdKey, input.sessionId);
  return { bundle, ctx };
}

function rehydrateContext(input: {
  readonly bundle: ReturnType<typeof buildBundle>;
  readonly serializedContext: Record<string, unknown>;
}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, input.bundle);
  ctx.set(
    ChannelKey,
    deserializeRuntimeAdapter(
      input.bundle.adapterRegistry,
      input.serializedContext[ChannelKey.name],
    ),
  );
  ctx.set(ContinuationTokenKey, input.serializedContext[ContinuationTokenKey.name] as string);
  ctx.set(SessionIdKey, input.serializedContext[SessionIdKey.name] as string);
  return ctx;
}

function createSession(sessionId: string): HarnessSession {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:parent",
    history: [],
    sessionId,
  };
}

function authorizationPayload(
  event: SubagentAuthorizationEvent,
): SubagentAuthorizationEventHookPayload {
  return {
    callId: "call-child",
    childSessionId: "child-session",
    event,
    kind: "subagent-authorization-event",
    subagentName: "researcher",
  };
}

function createCapturingWritable(chunks: Uint8Array[]): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
}

function decodeEvent(chunk: Uint8Array): TimedHandleMessageStreamEvent {
  return JSON.parse(new TextDecoder().decode(chunk).trim()) as TimedHandleMessageStreamEvent;
}

describe("subagent authorization proxy", () => {
  it("preserves events and parent adapter state across required/completed steps", async () => {
    const parentSessionId = "parent-session";
    const session = createSession(parentSessionId);
    const { bundle, ctx } = buildContext({
      adapter: authorizationAdapter,
      sessionId: parentSessionId,
    });
    const chunks: Uint8Array[] = [];
    const parentWritable = createCapturingWritable(chunks);
    const requiredEvent: SubagentAuthorizationEvent = {
      data: {
        authorization: {
          displayName: "Linear",
          instructions: "Sign in to continue.",
          url: "https://idp.example/authorize",
        },
        description: "Authorization required for linear",
        name: "linear",
        sequence: 0,
        stepIndex: 1,
        turnId: "child-turn",
        webhookUrl: "https://eve.example/connections/linear/callback/child-session%3Aauth",
      },
      type: "authorization.required",
    };

    const required = await emitProxiedSubagentEvent({
      ctx,
      durableSession: projectToDurableSession(session),
      hookPayload: authorizationPayload(requiredEvent),
      parentWritable,
    });

    expect(required.sessionState.continuationToken).toBe("http:auth-thread");
    expect(required.serializedContext[ContinuationTokenKey.name]).toBe("http:auth-thread");
    expect(required.serializedContext[ChannelKey.name]).toEqual({
      kind: authorizationAdapter.kind,
      state: { pendingName: "linear" },
    });

    const completedEvent: SubagentAuthorizationEvent = {
      data: {
        authorization: requiredEvent.data.authorization,
        name: "linear",
        outcome: "authorized",
        sequence: 0,
        stepIndex: 2,
        turnId: "child-turn",
      },
      type: "authorization.completed",
    };
    const completed = await emitProxiedSubagentEvent({
      ctx: rehydrateContext({ bundle, serializedContext: required.serializedContext }),
      durableSession: required.sessionState.snapshot!.session,
      hookPayload: authorizationPayload(completedEvent),
      parentWritable,
    });

    expect(completed.serializedContext[ChannelKey.name]).toEqual({
      kind: authorizationAdapter.kind,
      state: { outcome: "authorized" },
    });
    expect(chunks).toHaveLength(2);
    expect(decodeEvent(chunks[0]!)).toMatchObject(requiredEvent);
    expect(decodeEvent(chunks[1]!)).toMatchObject(completedEvent);
  });
});

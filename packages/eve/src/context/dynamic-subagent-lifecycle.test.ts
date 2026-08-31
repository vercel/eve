import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  buildDynamicSubagentTools,
  dispatchDynamicSubagentEvent,
  getDynamicSubagentSelection,
  refreshDynamicSessionSubagentsForRuntimeRevision,
} from "#context/dynamic-subagent-lifecycle.js";
import {
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionIdKey,
  TurnDynamicSubagentSelectionsKey,
} from "#context/keys.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineRemoteAgent } from "#public/definitions/remote-agent.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import type { ResolvedDynamicSubagentResolver } from "#runtime/subagents/registry.js";

describe("dynamic subagent lifecycle", () => {
  it("omits a subagent when its resolver returns null", async () => {
    const ctx = createContext();
    const { resolver } = createResolver({ handler: () => null });

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)).toEqual([]);
    expect(getDynamicSubagentSelection(ctx, resolver.nodeId)).toBeUndefined();
  });

  it("exposes a subagent with the returned agent config", async () => {
    const ctx = createContext();
    const created = createResolver();
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: { "session.started": () => created.agentConfig },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)).toMatchObject([
      {
        description: expect.stringContaining("Research the request."),
        name: "researcher",
        resultKind: "subagent",
      },
    ]);
    expect(getDynamicSubagentSelection(ctx, resolver.nodeId)).toBeDefined();
  });

  it("lets a turn-scoped null hide a session-scoped selection", async () => {
    const ctx = createContext();
    const created = createResolver({
      eventNames: ["session.started", "turn.started"],
    });
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: {
        "session.started": () => created.agentConfig,
        "turn.started": () => null,
      },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(buildDynamicSubagentTools(ctx)).toHaveLength(1);

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn-1" }),
      messages: [],
      resolvers: [resolver],
    });
    expect(buildDynamicSubagentTools(ctx)).toEqual([]);
    expect(getDynamicSubagentSelection(ctx, resolver.nodeId)).toBeUndefined();
  });

  it("runs every dynamic local and remote selection in the background", async () => {
    const ctx = createContext();
    const created = createResolver({ eventNames: ["session.started", "turn.started"] });
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: {
        "session.started": () =>
          defineAgent({
            description: "Research in the background.",
            model: "openai/gpt-5.5",
            modelContextWindowTokens: 200_000,
          }),
        "turn.started": () =>
          defineRemoteAgent({
            description: "Review remotely.",
            url: "https://review.example.com",
          }),
      },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(buildDynamicSubagentTools(ctx)[0]?.execution).toBe("background");
    expect(buildDynamicSubagentTools(ctx)[0]?.resultKind).toBe("subagent");

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn-1" }),
      messages: [],
      resolvers: [resolver],
    });
    expect(buildDynamicSubagentTools(ctx)[0]?.execution).toBe("background");
    expect(buildDynamicSubagentTools(ctx)[0]?.resultKind).toBe("subagent");
  });

  it("exposes a dynamic selection without root configuration", async () => {
    const ctx = createContext();
    const created = createResolver();
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: {
        "session.started": () =>
          defineAgent({
            description: "Research in the background.",
            model: "openai/gpt-5.5",
            modelContextWindowTokens: 200_000,
          }),
      },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)[0]?.execution).toBe("background");
  });

  it("lets a turn-scoped agent config switch the subagent model", async () => {
    const ctx = createContext();
    const created = createResolver({
      eventNames: ["session.started", "turn.started"],
    });
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: {
        "session.started": () =>
          defineAgent({
            description: "Research the request.",
            model: "anthropic/claude-sonnet-4.5",
            modelContextWindowTokens: 200_000,
          }),
        "turn.started": () =>
          defineAgent({
            description: "Research the request deeply.",
            model: "anthropic/claude-opus-4.6",
            modelContextWindowTokens: 200_000,
          }),
      },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });
    const sessionSelection = getDynamicSubagentSelection(ctx, resolver.nodeId);
    expect(sessionSelection?.kind).toBe("subagent");
    expect(
      sessionSelection?.kind === "subagent" ? sessionSelection.agentConfig.model.id : null,
    ).toBe("anthropic/claude-sonnet-4.5");

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn-1" }),
      messages: [],
      resolvers: [resolver],
    });
    const turnSelection = getDynamicSubagentSelection(ctx, resolver.nodeId);
    expect(turnSelection?.kind).toBe("subagent");
    expect(turnSelection?.kind === "subagent" ? turnSelection.agentConfig : null).toMatchObject({
      description: "Research the request deeply.",
      model: { id: "anthropic/claude-opus-4.6" },
    });
  });

  it("runs dynamic local selections in the background", async () => {
    const ctx = createContext();
    const selected = defineAgent({
      description: "Research the request.",
      model: "openai/gpt-5.5",
      modelContextWindowTokens: 200_000,
    });
    const created = createResolver({ handler: () => selected });

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [created.resolver],
    });

    expect(buildDynamicSubagentTools(ctx)[0]?.execution).toBe("background");
  });

  it("exposes a remote subagent with the returned remote config", async () => {
    const ctx = createContext();
    const created = createResolver();
    const auth = vi.fn(async () => ({ headers: { authorization: "Bearer selected" } }));
    const headers = vi.fn(async () => ({ "x-tenant": "acme" }));
    const remoteAgent = defineRemoteAgent({
      auth,
      description: "Research on the remote deployment.",
      forwardPrincipal: true,
      headers,
      outputSchema: { properties: { answer: { type: "string" } }, type: "object" },
      url: async () => "https://research.example.com",
    });
    const credentialsFactory = Object.assign(
      () => ({ auth: remoteAgent.auth, headers: remoteAgent.headers }),
      { stepId: "eve:dynamic-remote-agent//researcher" },
    );
    Object.defineProperty(remoteAgent, "__eveResolveRemoteAgentCredentials", {
      value: credentialsFactory,
    });
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: {
        "session.started": () => remoteAgent,
      },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)).toMatchObject([
      {
        description: expect.stringContaining("Research on the remote deployment."),
        name: "researcher",
        resultKind: "subagent",
      },
    ]);
    expect(getDynamicSubagentSelection(ctx, resolver.nodeId)).toMatchObject({
      kind: "remote",
      prepared: {
        inputSchema: {
          properties: { agentId: expect.any(Object) },
        },
      },
      remoteAgent: {
        credentialsStepId: "eve:dynamic-remote-agent//researcher",
        forwardPrincipal: true,
        path: "/eve/v1/session",
        url: "https://research.example.com",
      },
    });
    expect(auth).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(JSON.stringify(getDynamicSubagentSelection(ctx, resolver.nodeId))).not.toContain(
      "Bearer selected",
    );
  });

  it("runs dynamic remote selections in the background", async () => {
    const ctx = createContext();
    const remoteAgent = defineRemoteAgent({
      description: "Research on the remote deployment.",
      url: "https://research.example.com",
    });
    const created = createResolver({ handler: () => remoteAgent });

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [created.resolver],
    });

    expect(buildDynamicSubagentTools(ctx)[0]?.execution).toBe("background");
  });

  it("exposes every remote entry in a dynamic subagent map with a keyed identity", async () => {
    const ctx = createContext();
    const created = createResolver();
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: {
        "session.started": () => ({
          review: defineRemoteAgent({
            description: "Reviews the request.",
            url: "https://review.example.com",
          }),
          triage: defineRemoteAgent({
            description: "Classifies the request.",
            url: "https://triage.example.com",
          }),
        }),
      },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)).toMatchObject([
      {
        name: "researcher__review",
        runtimeAction: {
          kind: "remote-agent-call",
          nodeId: "subagents/researcher#review",
          remoteAgentName: "researcher__review",
        },
      },
      {
        name: "researcher__triage",
        runtimeAction: {
          kind: "remote-agent-call",
          nodeId: "subagents/researcher#triage",
          remoteAgentName: "researcher__triage",
        },
      },
    ]);
    expect(getDynamicSubagentSelection(ctx, "subagents/researcher#triage")).toMatchObject({
      kind: "remote",
      remoteAgent: { url: "https://triage.example.com" },
    });
    expect(getDynamicSubagentSelection(ctx, resolver.nodeId)).toBeUndefined();
  });

  it("lets a turn map replace every session entry from the same resolver", async () => {
    const ctx = createContext();
    const created = createResolver({ eventNames: ["session.started", "turn.started"] });
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: {
        "session.started": () => ({
          triage: defineRemoteAgent({
            description: "Classifies.",
            url: "https://triage.example.com",
          }),
          review: defineRemoteAgent({ description: "Reviews.", url: "https://review.example.com" }),
        }),
        "turn.started": () => ({
          review: defineRemoteAgent({
            description: "Reviews deeply.",
            url: "https://deep-review.example.com",
          }),
        }),
      },
    };

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });
    await dispatchDynamicSubagentEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn-1" }),
      messages: [],
      resolvers: [resolver],
    });

    expect(ctx.get(TurnDynamicSubagentSelectionsKey)).toBeDefined();
    expect(buildDynamicSubagentTools(ctx).map((tool) => tool.name)).toEqual(["researcher__review"]);
    expect(getDynamicSubagentSelection(ctx, "subagents/researcher#triage")).toBeUndefined();
    expect(getDynamicSubagentSelection(ctx, "subagents/researcher#review")?.kind).toBe("remote");
  });

  it("omits an invalid non-null result", async () => {
    const ctx = createContext();
    const { resolver } = createResolver({
      handler: () => false,
    });

    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(buildDynamicSubagentTools(ctx)).toEqual([]);
  });

  it("refreshes session availability once per runtime revision", async () => {
    const ctx = createContext();
    const created = createResolver();
    const handler = vi.fn(() => created.agentConfig);
    const resolver: ResolvedDynamicSubagentResolver = {
      ...created.resolver,
      events: { "session.started": handler },
    };

    await refreshDynamicSessionSubagentsForRuntimeRevision({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
      runtimeRevision: "deployment:one",
    });
    await refreshDynamicSessionSubagentsForRuntimeRevision({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
      runtimeRevision: "deployment:one",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(ctx.get(SessionDynamicSubagentRuntimeRevisionKey)).toBe("deployment:one");
    expect(buildDynamicSubagentTools(ctx)).toHaveLength(1);
  });
});

function createContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "session-1");
  return ctx;
}

function createResolver(
  input: {
    readonly eventNames?: readonly string[];
    readonly handler?: () => unknown;
  } = {},
): {
  readonly agentConfig: ReturnType<typeof defineAgent>;
  readonly resolver: ResolvedDynamicSubagentResolver;
} {
  const agentConfig = defineAgent({
    description: "Research the request.",
    model: "openai/gpt-5.5",
    modelContextWindowTokens: 200_000,
  });
  const eventNames = input.eventNames ?? ["session.started"];
  const handler = input.handler ?? (() => null);

  return {
    agentConfig,
    resolver: {
      eventNames,
      events: Object.fromEntries(eventNames.map((eventName) => [eventName, handler])),
      kind: "subagent",
      logicalPath: "agent.ts",
      name: "researcher",
      nodeId: "subagents/researcher",
      sourceId: "agent.ts",
      sourceKind: "module",
    },
  };
}

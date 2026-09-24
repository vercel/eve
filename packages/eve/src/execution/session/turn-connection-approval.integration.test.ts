import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { turnStep } from "#execution/session/turn-step.js";
import type { DurableStepResult, TurnStepPayload } from "#execution/session/turn-step-types.js";
import {
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
} from "#harness/approval-candidates.js";
import { setPendingAuthorization } from "#harness/authorization.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";
import type {
  ResolvedDynamicConnectionResolver,
  ResolvedDynamicToolResolver,
} from "#runtime/types.js";
import connectionSearch from "#tools/framework/connection-search.js";
import { clearDurableDynamicCallbacks } from "#tools/durable-callbacks.js";
import type { ApprovalResponseContext } from "#approval/definition.js";

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));
vi.mock("#runtime/agent/resolve-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#runtime/agent/resolve-model.js")>()),
  resolveRuntimeModelReference: vi.fn(),
}));

const alice = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const bob = { ...alice, principalId: "bob" };
const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};
const sessionId = "turn-connection-approval";

function modelResponse(toolName?: string, callId?: string, connection = "notes") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(toolName
          ? [
              {
                type: "tool-call" as const,
                toolCallId: callId ?? (toolName === "connection_search" ? "search" : "save"),
                toolName,
                input: JSON.stringify(
                  toolName === "connection_search"
                    ? { connection, keywords: "save" }
                    : { body: { note: "hello" } },
                ),
              },
            ]
          : [
              { type: "text-start" as const, id: "reply" },
              { type: "text-delta" as const, id: "reply", delta: "Saved." },
              { type: "text-end" as const, id: "reply" },
            ]),
        {
          type: "finish" as const,
          finishReason: {
            raw: undefined,
            unified: toolName ? ("tool-calls" as const) : ("stop" as const),
          },
          usage,
        },
      ],
    }),
  };
}

function setup(
  scope: "turn.started" | "session.started" = "turn.started",
  reject = false,
  variation?: "destination" | "name" | "request-only",
) {
  const response = vi.fn((context: ApprovalResponseContext) => {
    expect(context.responder.principalId).toBe("bob");
    expect(context.session.initiator?.principalId).toBe("alice");
    return reject
      ? { status: "rejected" as const, reason: "Only the notes owner can approve." }
      : { status: "allowed" as const };
  });
  const policyTurns: string[] = [];
  let removed = false;
  const resolver = vi.fn((event: unknown) => {
    if (removed) return {};
    const sequence = (event as { data: { sequence?: number } }).data.sequence ?? 0;
    return {
      [variation === "name" && sequence > 0 ? "second-notes" : "notes"]: defineOpenAPIConnection({
        baseUrl:
          variation === "destination"
            ? `https://notes-${sequence}.example.com`
            : "https://notes.example.com",
        instanceKey: variation === "destination" ? `turn-${sequence}` : undefined,
        description: "Save notes",
        spec: {
          openapi: "3.0.0",
          info: { title: "Notes", version: "1.0.0" },
          paths: {
            "/notes": {
              post: {
                operationId: "saveNote",
                summary: "Save a note",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { note: { type: "string" } },
                        required: ["note"],
                      },
                    },
                  },
                },
                responses: { 200: { description: "Saved" } },
              },
            },
          },
        },
        approval: {
          request: () => "user-approval",
          response:
            variation === "request-only"
              ? undefined
              : (context) => {
                  policyTurns.push(
                    (event as { data: { turnId?: string } }).data.turnId ?? "session",
                  );
                  return response(context);
                },
        },
      }),
    };
  });
  const dynamicConnectionResolvers: ResolvedDynamicConnectionResolver[] = [
    {
      eventNames: [scope],
      events: { [scope]: resolver },
      logicalPath: "connections/notes.ts",
      slug: "notes",
      sourceId: "notes",
      sourceKind: "module",
    },
  ];
  const dynamicToolResolvers: ResolvedDynamicToolResolver[] = [
    {
      eventNames: ["step.started"],
      events: connectionSearch.events as ResolvedDynamicToolResolver["events"],
      logicalPath: "tools/connection-search.ts",
      slug: "connection-search",
      sourceId: "eve:connection-search",
      sourceKind: "module",
    },
  ];
  const adapter = { kind: "test" };
  const turnAgent = {
    id: "notes-agent",
    instructions: ["Save notes."],
    model: { id: "test" },
    skills: [],
    tools: [],
    workspaceSpec: { rootEntries: [] },
  };
  const resolvedAgent: Partial<CompiledBundle["resolvedAgent"]> = {
    connections: [],
    dynamicConnectionResolvers,
    dynamicToolResolvers,
  };
  const sandboxRegistry: {
    sandbox: CompiledBundle["graph"]["root"]["sandboxRegistry"]["sandbox"] | null;
  } = { sandbox: null };
  const bundle = {
    adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
    compiledArtifactsSource: { kind: "bundled" },
    graph: {
      nodesByNodeId: new Map(),
      root: {
        agent: resolvedAgent as CompiledBundle["resolvedAgent"],
        sandboxRegistry: sandboxRegistry as CompiledBundle["graph"]["root"]["sandboxRegistry"],
        turnAgent,
        channels: [],
        hookRegistry: createEmptyHookRegistry(),
        nodeId: "__root__",
        subagentRegistry: {
          dynamicNodeIds: new Set(),
          dynamicResolvers: [],
          preparedTools: [],
          subagentsByName: new Map(),
          subagentsByNodeId: new Map(),
        },
        toolRegistry: { preparedTools: [], toolsByName: new Map() },
      },
    },
    hookRegistry: createEmptyHookRegistry(),
    moduleMap: { nodes: {} },
    resolvedAgent: resolvedAgent as CompiledBundle["resolvedAgent"],
    subagentRegistry: {
      dynamicNodeIds: new Set(),
      dynamicResolvers: [],
      preparedTools: [],
      subagentsByName: new Map(),
      subagentsByNodeId: new Map(),
    },
    toolRegistry: { preparedTools: [], toolsByName: new Map() },
    turnAgent,
  } as CompiledBundle;
  vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
  const doStream = vi
    .fn()
    .mockImplementationOnce(() => modelResponse("connection_search"))
    .mockImplementationOnce(() => modelResponse("notes__saveNote"))
    .mockImplementation(() => modelResponse());
  vi.mocked(resolveRuntimeModelReference).mockResolvedValue(new MockLanguageModelV4({ doStream }));
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ saved: true }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const ctx = new ContextContainer();
  ctx.set(AuthKey, alice);
  ctx.set(InitiatorAuthKey, alice);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, adapter);
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionIdKey, sessionId);
  const session: HarnessSession = {
    agent: { modelReference: { id: "test" }, system: "Save notes.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "notes-session",
    history: [],
    sessionId,
  };
  let snapshot = {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session }),
  };
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  async function step(input?: TurnStepPayload): Promise<DurableStepResult> {
    const result = await turnStep({
      ...snapshot,
      input,
      sessionWritable: new WritableStream<Uint8Array>({
        write(chunk) {
          const text = new TextDecoder().decode(chunk);
          for (const line of text.split("\n")) {
            if (line.trim()) events.push(JSON.parse(line));
          }
        },
      }),
    });
    snapshot = result;
    return result;
  }
  return {
    doStream,
    events,
    fetch,
    resolver,
    response,
    step,
    policyTurns,
    removeConnection() {
      removed = true;
    },
    updateSession(update: (session: HarnessSession) => HarnessSession) {
      snapshot = {
        ...snapshot,
        sessionState: createDurableSessionState({
          session: update({
            ...session,
            ...readDurableSession(snapshot.sessionState),
            agent: session.agent,
            compaction: session.compaction,
          }),
        }),
      };
    },
  };
}

afterEach(() => {
  clearDurableDynamicCallbacks(sessionId);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("turn connection approval restoration", () => {
  it("authorizes requests from two originating turns independently in one cold delivery", async () => {
    const fixture = setup();
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's first note." }] },
    });
    const first = await fixture.step();
    const firstBatch = getPendingInputBatches(readDurableSession(first.sessionState).state)[0]!;
    fixture.doStream
      .mockImplementationOnce(() => modelResponse("connection_search", "search-2"))
      .mockImplementationOnce(() => modelResponse("notes__saveNote", "save-2"));
    await fixture.step({
      delivery: {
        kind: "deliver",
        payloads: [{ message: "Prepare Alice's second independent note." }],
      },
    });
    const second = await fixture.step();
    const batches = getPendingInputBatches(readDurableSession(second.sessionState).state);
    expect(batches).toHaveLength(2);
    expect(batches[1]!.event!.turnId).not.toBe(firstBatch.event!.turnId);
    clearDurableDynamicCallbacks(sessionId);
    await fixture.step({
      delivery: {
        kind: "deliver",
        auth: bob,
        payloads: [
          {
            inputResponses: batches.flatMap((batch) =>
              batch.requests.map((request) => ({
                requestId: request.requestId,
                optionId: "approve",
              })),
            ),
          },
        ],
      },
    });
    clearDurableDynamicCallbacks(sessionId);
    const resumed = await fixture.step();
    expect(fixture.policyTurns).toEqual(batches.map((batch) => batch.event!.turnId));
    expect(fixture.response).toHaveBeenCalledTimes(2);
    expect(
      getApprovalAuditState(readDurableSession(resumed.sessionState).state).settlements,
    ).toHaveLength(2);
    expect(fixture.fetch).toHaveBeenCalled();
    expect(fixture.events.filter((event) => event.type === "session.failed")).toEqual([]);
  });
  it.each([false, true])(
    "fails before execution when the resumed connection changes (cold: %s)",
    async (cold) => {
      const fixture = setup("turn.started", false, "destination");
      await fixture.step({
        delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note." }] },
      });
      const parked = await fixture.step();
      const request = getPendingInputBatches(readDurableSession(parked.sessionState).state)[0]!
        .requests[0]!;
      if (cold) clearDurableDynamicCallbacks(sessionId);
      await fixture.step({
        delivery: {
          kind: "deliver",
          auth: bob,
          payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
        },
      });
      if (cold) clearDurableDynamicCallbacks(sessionId);
      await expect(fixture.step()).rejects.toThrow(
        "connection for this tool call changed or is unavailable",
      );
      expect(fixture.response).toHaveBeenCalledOnce();
      expect(fixture.fetch).not.toHaveBeenCalled();
    },
  );

  it("checks both older and newer tool names, then refuses replay when the older connection is missing", async () => {
    const fixture = setup("turn.started", false, "name");
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's first note." }] },
    });
    await fixture.step();
    fixture.doStream
      .mockImplementationOnce(() => modelResponse("connection_search", "search-2", "second-notes"))
      .mockImplementationOnce(() => modelResponse("second-notes__saveNote", "save-2"));
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's second note." }] },
    });
    const second = await fixture.step();
    const batches = getPendingInputBatches(readDurableSession(second.sessionState).state);
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.requests[0]!.action.toolName)).toEqual([
      "notes__saveNote",
      "second-notes__saveNote",
    ]);
    clearDurableDynamicCallbacks(sessionId);
    await fixture.step({
      delivery: {
        kind: "deliver",
        auth: bob,
        payloads: [
          {
            inputResponses: batches.flatMap((batch) =>
              batch.requests.map((request) => ({
                requestId: request.requestId,
                optionId: "approve",
              })),
            ),
          },
        ],
      },
    });
    clearDurableDynamicCallbacks(sessionId);
    await expect(fixture.step()).rejects.toThrow(
      "connection for this tool call changed or is unavailable",
    );
    expect(fixture.policyTurns).toEqual(batches.map((batch) => batch.event!.turnId));
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing connection before replay even without a response policy", async () => {
    const fixture = setup("turn.started", false, "request-only");
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note." }] },
    });
    const parked = await fixture.step();
    const request = getPendingInputBatches(readDurableSession(parked.sessionState).state)[0]!
      .requests[0]!;
    fixture.removeConnection();
    await expect(
      fixture.step({
        delivery: {
          kind: "deliver",
          auth: bob,
          payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
        },
      }),
    ).rejects.toThrow("connection for this tool call changed or is unavailable");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("leaves the request pending when its connection can no longer be reconstructed", async () => {
    const fixture = setup();
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note." }] },
    });
    const parked = await fixture.step();
    const request = getPendingInputBatches(readDurableSession(parked.sessionState).state)[0]!
      .requests[0]!;
    fixture.removeConnection();
    await fixture.step({
      delivery: {
        kind: "deliver",
        auth: bob,
        payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
      },
    });
    clearDurableDynamicCallbacks(sessionId);
    const refused = await fixture.step();
    expect(fixture.response).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
    const state = readDurableSession(refused.sessionState).state;
    expect(getPendingInputBatches(state)[0]!.requests[0]!.requestId).toBe(request.requestId);
    expect(getApprovalAuditState(state).candidateHistory).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.stringContaining("cannot replay its approvalResponse callback"),
      }),
    ]);
  });

  it("restores the originating connection for a sign-in callback without a premature turn", async () => {
    const fixture = setup();
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note for Bob." }] },
    });
    const parked = await fixture.step();
    const batch = getPendingInputBatches(readDurableSession(parked.sessionState).state)[0]!;
    const request = batch.requests[0]!;
    const ingested = await fixture.step({
      delivery: {
        kind: "deliver",
        auth: bob,
        payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
      },
    });
    const candidate = getApprovalAuditState(readDurableSession(ingested.sessionState).state)
      .activeCandidates[0]!;
    const challenges = [
      {
        attemptId: "sign-in-1",
        candidateId: candidate.candidateId,
        name: "notes",
        principal: { type: "user" as const, id: "bob" },
        hookUrl: "https://example.com/callback",
        challenge: { url: "https://example.com/sign-in" },
      },
    ];
    fixture.updateSession((session) => ({
      ...session,
      state: setPendingAuthorization(
        markApprovalCandidateAuthorizationRequired({
          state: session.state,
          candidateId: candidate.candidateId,
          authorizationChallenges: challenges,
        }),
        { challenges },
      ),
    }));
    clearDurableDynamicCallbacks(sessionId);
    const start = fixture.events.length;
    await fixture.step({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              connectionName: "notes",
              attemptId: "sign-in-1",
              callback: { params: { code: "approved" } },
            },
          },
        ],
      },
    });
    expect(fixture.policyTurns).toEqual([batch.event!.turnId]);
    expect(fixture.response).toHaveBeenCalledOnce();
    expect(fixture.fetch).toHaveBeenCalledOnce();
    const events = fixture.events.slice(start);
    expect(events.findIndex((event) => event.type === "authorization.completed")).toBeLessThan(
      events.findIndex((event) => event.type === "turn.started"),
    );
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
  });

  it.each([false, true])(
    "approves and executes a discovered tool with a cold callback cache: %s",
    async (cold) => {
      const fixture = setup();
      await fixture.step({
        delivery: { kind: "deliver", payloads: [{ message: "Save hello in notes." }] },
      });
      const parked = await fixture.step();
      const request = getPendingInputBatches(readDurableSession(parked.sessionState).state)[0]!
        .requests[0]!;
      expect(request.action.toolName).toBe("notes__saveNote");
      expect(parked.serializedContext["eve.pendingConnectionCalls"]).toEqual({
        [request.action.callId]: {
          connectionName: "notes",
          instanceId: expect.stringMatching(/^connection:/),
        },
      });
      expect(fixture.fetch).not.toHaveBeenCalled();
      if (cold) clearDurableDynamicCallbacks(sessionId);
      const candidate = await fixture.step({
        delivery: {
          kind: "deliver",
          auth: bob,
          payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
        },
      });
      expect(
        getApprovalAuditState(readDurableSession(candidate.sessionState).state).activeCandidates,
      ).toHaveLength(1);
      if (cold) clearDurableDynamicCallbacks(sessionId);
      const resumed = await fixture.step();
      expect(fixture.response).toHaveBeenCalledOnce();
      expect(
        getApprovalAuditState(readDurableSession(resumed.sessionState).state).settlements,
      ).toEqual([expect.objectContaining({ outcome: "allowed", requestId: request.requestId })]);
      expect(fixture.fetch).toHaveBeenCalledOnce();
      expect(resumed.serializedContext["eve.pendingConnectionCalls"]).toEqual({});
      expect(fixture.events.filter((event) => event.type === "turn.started")).toHaveLength(2);
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          type: "action.result",
          data: expect.objectContaining({
            status: "completed",
            result: expect.objectContaining({ toolName: "notes__saveNote" }),
          }),
        }),
      );
    },
  );

  it("preserves the author's rejection reason after a cold continuation", async () => {
    const fixture = setup("turn.started", true);
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Save hello in notes." }] },
    });
    const parked = await fixture.step();
    const request = getPendingInputBatches(readDurableSession(parked.sessionState).state)[0]!
      .requests[0]!;
    await fixture.step({
      delivery: {
        kind: "deliver",
        auth: bob,
        payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
      },
    });
    clearDurableDynamicCallbacks(sessionId);
    const rejected = await fixture.step();
    expect(fixture.response).toHaveBeenCalledOnce();
    expect(
      getApprovalAuditState(readDurableSession(rejected.sessionState).state).candidateHistory,
    ).toEqual([
      expect.objectContaining({ status: "rejected", reason: "Only the notes owner can approve." }),
    ]);
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
  });

  it("preserves session-scoped connection approval", async () => {
    const fixture = setup("session.started");
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Save hello in notes." }] },
    });
    const parked = await fixture.step();
    const request = getPendingInputBatches(readDurableSession(parked.sessionState).state)[0]!
      .requests[0]!;
    await fixture.step({
      delivery: {
        kind: "deliver",
        auth: bob,
        payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
      },
    });
    clearDurableDynamicCallbacks(sessionId);
    await fixture.step();
    expect(fixture.response).toHaveBeenCalledOnce();
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });
});

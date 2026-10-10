import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  createDurableSessionValues,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { turnStep } from "#execution/session/turn-step.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";
import type { DurableStepResult, TurnStepPayload } from "#execution/session/turn-step-types.js";
import {
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
} from "#harness/hitl/candidates.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";

import { withSignIns } from "#harness/hitl/sign-ins.js";
import { readHitlState, writeHitlState } from "#harness/hitl/requests.js";

import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { defineInteractiveAuthorization } from "#shared/connection-types.js";
import { suspendedSteps } from "#harness/session-machine/view.js";
import type { HarnessSession } from "#harness/types.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";
import type { ResolvedDynamicConnectionResolver } from "#runtime/types.js";
import { clearDurableDynamicCallbacks } from "#tools/durable-callbacks.js";
import type { ApprovalResponseContext } from "#approval/definition.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

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
const TOOL_GONE_RESULT =
  'The tool "notes__saveNote" is no longer available, so the call didn\'t run. If the task still needs it, find an available tool with eve__search and make a new call.';

/** A model step that saves notes through `execute`, or replies when `callId` is omitted. */
function modelResponse(callId?: string | readonly string[], connection = "notes") {
  const callIds = callId === undefined ? [] : typeof callId === "string" ? [callId] : callId;
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(callIds.length > 0
          ? callIds.map((toolCallId) => ({
              type: "tool-call" as const,
              toolCallId,
              toolName: CALL_TOOL_NAME,
              input: JSON.stringify({
                name: `${connection}__saveNote`,
                input: { body: { note: "hello" } },
              }),
            }))
          : [
              { type: "text-start" as const, id: "reply" },
              { type: "text-delta" as const, id: "reply", delta: "Saved." },
              { type: "text-end" as const, id: "reply" },
            ]),
        {
          type: "finish" as const,
          finishReason: {
            raw: undefined,
            unified: callIds.length > 0 ? ("tool-calls" as const) : ("stop" as const),
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
  variation?: "destination" | "name" | "request-only" | "unapproved-name",
) {
  const response = vi.fn((context: ApprovalResponseContext) => {
    expect(context.response.principal.principalId).toBe("bob");
    expect(context.session.initiator?.principalId).toBe("alice");
    return reject
      ? { status: "rejected" as const, reason: "Only the notes owner can approve." }
      : { status: "allowed" as const };
  });
  const policyTurns: string[] = [];
  let connection: "available" | "failing" | "removed" = "available";
  const resolver = vi.fn((event: unknown) => {
    if (connection === "failing") throw new Error("The notes directory is unreachable.");
    if (connection === "removed") return {};
    const sequence = (event as { data: { sequence?: number } }).data.sequence ?? 0;
    return {
      [(variation === "name" || variation === "unapproved-name") && sequence > 0
        ? "second-notes"
        : "notes"]: defineOpenAPIConnection({
        baseUrl:
          variation === "destination"
            ? `https://notes-${sequence}.example.com`
            : "https://notes.example.com",
        instanceKey: variation === "destination" ? `turn-${sequence}` : undefined,
        description: "Save notes",
        headers: { "X-Caller": (ctx) => ctx.session.auth.current?.principalId ?? "none" },
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
        approval:
          variation === "unapproved-name"
            ? undefined
            : {
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
    dynamicSkillResolvers: [],
    dynamicToolResolvers: [],
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
        hookRegistry: createRuntimeHookRegistry([]),
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
    hookRegistry: createRuntimeHookRegistry([]),
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
    .mockImplementationOnce(() => modelResponse("save"))
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
  ctx.set(SessionIdKey, sessionId);
  ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
  const session: HarnessSession = {
    agent: { modelReference: { id: "test" }, system: "Save notes.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "notes-session",
    history: [],
    sessionId,
  };
  let snapshot = {
    serializedContext: serializeContext(ctx),
    ...createDurableSessionValues(session),
  };
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  async function step(input?: TurnStepPayload): Promise<DurableStepResult> {
    const stepInput = {
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
    };
    const result = await runSessionStateStep(stepInput, turnStep);
    snapshot = {
      history: result.history,
      serializedContext: result.serializedContext,
      sessionState: result.sessionState,
    };
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
    /** The session state as last committed. */
    state() {
      return readDurableSession(snapshot.sessionState).state;
    },
    /** What the connection's resolver does from now on. */
    setConnection(state: typeof connection) {
      connection = state;
    },
    updateSession(update: (session: HarnessSession) => HarnessSession) {
      snapshot = {
        ...snapshot,
        ...createDurableSessionValues(
          update({
            ...session,
            ...readDurableSession(snapshot.sessionState),
            agent: session.agent,
            compaction: session.compaction,
            history: snapshot.history,
          }),
        ),
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
  it("keeps the provider tools and system prompt identical while connections change", async () => {
    const fixture = setup("turn.started", false, "unapproved-name");
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's first note." }] },
    });
    await fixture.step();
    fixture.doStream.mockImplementationOnce(() => modelResponse("save-2", "second-notes"));
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's second note." }] },
    });
    await fixture.step();
    expect(fixture.fetch).toHaveBeenCalledTimes(2);

    const requests = fixture.doStream.mock.calls.map(
      ([options]) =>
        options as {
          prompt: { role: string; content: unknown }[];
          tools: { name: string }[];
        },
    );
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const [first, ...later] = requests;
    expect(first!.tools.map((tool) => tool.name)).toEqual([SEARCH_TOOL_NAME, CALL_TOOL_NAME]);
    const system = (request: (typeof requests)[number]) =>
      request.prompt.filter((message) => message.role === "system");
    for (const request of later) {
      expect(request.tools).toEqual(first!.tools);
      expect(system(request)).toEqual(system(first!));
    }
    // Connection names reach the model only through appended context messages.
    const last = JSON.stringify(requests.at(-1)!.prompt);
    expect(JSON.stringify(system(first!))).not.toContain("- notes:");
    expect(last).toContain("- notes: Save notes");
    expect(last).toContain("- second-notes: Save notes");
  });

  it("rejects only the approved call whose instance pin was evicted", async () => {
    const fixture = setup("turn.started", false, "request-only");
    // One more parked call than the pin map holds evicts the first call's pin.
    const callIds = Array.from({ length: 51 }, (_, index) => `save-${index}`);
    fixture.doStream.mockReset();
    fixture.doStream
      .mockImplementationOnce(() => modelResponse(callIds))
      .mockImplementation(() => modelResponse());
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's notes." }] },
    });
    const parked = await fixture.step();
    const requests = suspendedSteps(readDurableSession(parked.sessionState).state).flatMap(
      (batch) => batch.requests,
    );
    await fixture.step({
      delivery: {
        kind: "deliver",
        auth: alice,
        payloads: [
          {
            inputResponses: requests.map((request) => ({
              requestId: request.requestId,
              optionId: "approve",
            })),
          },
        ],
      },
    });
    // A missing pin can't prove the connection is unchanged, so that call fails
    // rather than re-pinning to whatever the connection resolves to now.
    const failed = fixture.events.flatMap((event) =>
      event.type === "action.result" && event.data.status === "failed"
        ? [event.data.result as { callId: string; output: unknown }]
        : [],
    );
    expect(failed.map((result) => result.callId)).toEqual(["save-0"]);
    expect(JSON.stringify(failed[0]!.output)).toContain(
      "connection for this tool call changed or is unavailable",
    );
    expect(fixture.fetch).toHaveBeenCalledTimes(50);
  });

  it("fails an approved call whose connection is gone, and the session continues", async () => {
    const fixture = setup("turn.started", false, "request-only");
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note." }] },
    });
    const parked = await fixture.step();
    const request = suspendedSteps(readDurableSession(parked.sessionState).state)[0]!.requests[0]!;
    fixture.setConnection("removed");
    const resumed = await fixture.step({
      delivery: {
        kind: "deliver",
        auth: alice,
        payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
      },
    });

    expect(fixture.fetch).not.toHaveBeenCalled();
    const failed = fixture.events.findIndex(
      (event) =>
        event.type === "action.result" &&
        event.data.status === "failed" &&
        (event.data.result as { callId: string }).callId === request.action.callId,
    );
    expect(fixture.events[failed]?.data.result).toMatchObject({ output: TOOL_GONE_RESULT });
    // The model reads the failure as the call's result, and the turn completes.
    expect(JSON.stringify(fixture.doStream.mock.calls.at(-1)![0])).toContain(
      "is no longer available, so the call didn't run",
    );
    expect(fixture.events.slice(failed).map((event) => event.type)).toContain("turn.completed");
    expect(suspendedSteps(readDurableSession(resumed.sessionState).state)).toEqual([]);
  });

  describe("a connection with a response policy, while its request waits", () => {
    /** Parks Alice's note for approval and returns its request. */
    async function parkNote(fixture: ReturnType<typeof setup>) {
      await fixture.step({
        delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note." }] },
      });
      const parked = await fixture.step();
      return suspendedSteps(readDurableSession(parked.sessionState).state)[0]!.requests[0]!;
    }

    /** Delivers Bob's approval, then runs until the session waits again. */
    async function approveAsBob(fixture: ReturnType<typeof setup>, requestId: string) {
      let result = await fixture.step({
        delivery: {
          kind: "deliver",
          auth: bob,
          payloads: [{ inputResponses: [{ requestId, optionId: "approve" }] }],
        },
      });
      while (result.action === "continue") result = await fixture.step();
      return readDurableSession(result.sessionState).state;
    }

    it("settles the request as unavailable when the connection is gone", async () => {
      const fixture = setup();
      const request = await parkNote(fixture);
      fixture.setConnection("removed");

      const state = await approveAsBob(fixture, request.requestId);

      expect(fixture.response).not.toHaveBeenCalled();
      expect(fixture.fetch).not.toHaveBeenCalled();
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          type: "approval.candidate",
          data: expect.objectContaining({
            outcome: "failed",
            reason: "The tool this approval was for is no longer available, so the call won't run.",
            requestId: request.requestId,
            responderPrincipalId: "bob",
          }),
        }),
      );
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          type: "input.resolved",
          data: expect.objectContaining({
            resolutions: [
              expect.objectContaining({ outcome: "denied", requestId: request.requestId }),
            ],
          }),
        }),
      );
      // The model reads the failure under its own eve__tool call.
      expect(modelToolResult(fixture, request.action.callId)).toEqual(
        expect.objectContaining({
          output: { type: "error-text", value: TOOL_GONE_RESULT },
          toolName: CALL_TOOL_NAME,
        }),
      );
      expect(suspendedSteps(state)).toEqual([]);
      expect(fixture.events.at(-1)?.type).toBe("session.waiting");
      expect(fixture.events.map((event) => event.type)).toContain("turn.completed");
    });

    it("keeps the request pending while the connection's resolver fails, and a retried approval runs it", async () => {
      const fixture = setup();
      const request = await parkNote(fixture);
      fixture.setConnection("failing");
      const before = fixture.events.length;

      // The step restores its connections before it reads the approval, so the
      // failure fails the turn, parks the session, and commits nothing.
      await approveAsBob(fixture, request.requestId);

      expect(fixture.events.slice(before).map((event) => event.type)).toEqual([
        "step.failed",
        "turn.failed",
        "session.waiting",
      ]);
      expect(suspendedSteps(fixture.state())[0]!.requests[0]!.requestId).toBe(request.requestId);
      expect(getApprovalAuditState(fixture.state()).candidateHistory).toEqual([]);
      expect(fixture.response).not.toHaveBeenCalled();
      expect(fixture.fetch).not.toHaveBeenCalled();

      fixture.setConnection("available");
      const approved = await approveAsBob(fixture, request.requestId);

      expect(fixture.response).toHaveBeenCalledOnce();
      expect(fixture.fetch).toHaveBeenCalledOnce();
      expect(suspendedSteps(approved)).toEqual([]);
    });
  });

  it("names the responder, not the requester, on a candidate's sign-in events", async () => {
    const signIn = defineInteractiveAuthorization<{ readonly nonce: string }>({
      async getToken() {
        throw new ConnectionAuthorizationRequiredError("notes-approver");
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/sign-in" }, resume: { nonce: "n1" } };
      },
      async completeAuthorization() {
        return { token: "approver-token" };
      },
    });
    const fixture = setup();
    fixture.response.mockImplementation(((context: ApprovalResponseContext) =>
      context.auth
        .getToken(signIn, { authKey: "notes-approver" })
        .then(() => ({ status: "allowed" as const }))) as never);
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note for Bob." }] },
    });
    const parked = await fixture.step();
    const request = suspendedSteps(readDurableSession(parked.sessionState).state)[0]!.requests[0]!;

    const signInStart = fixture.events.length;
    await fixture.step({
      delivery: {
        kind: "deliver",
        auth: bob,
        payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
      },
    });
    // Ingesting the candidate, running its policy, and parking on sign-in are separate passes.
    for (let result = await fixture.step(); result.action === "continue";) {
      result = await fixture.step();
    }
    const candidate = fixture.events
      .slice(signInStart)
      .find((event) => event.type === "approval.candidate");
    const required = fixture.events
      .slice(signInStart)
      .find((event) => event.type === "authorization.required");
    expect(candidate?.data).toMatchObject({ responderPrincipalId: "bob" });
    expect(required?.data).toMatchObject({
      attemptId: expect.any(String),
      candidateId: candidate?.data.candidateId,
      principalId: "bob",
    });

    const completionStart = fixture.events.length;
    await fixture.step({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              attemptId: required?.data.attemptId,
              callback: { method: "GET", params: { code: "ok" } },
              connectionName: required?.data.name,
            },
          },
        ],
      },
    });
    const completed = fixture.events
      .slice(completionStart)
      .find((event) => event.type === "authorization.completed");
    expect(completed?.data).toMatchObject({
      attemptId: required?.data.attemptId,
      outcome: "authorized",
      principalId: "bob",
    });
  });

  it("restores the originating connection for a sign-in callback without a premature turn", async () => {
    const fixture = setup();
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note for Bob." }] },
    });
    const parked = await fixture.step();
    const batch = suspendedSteps(readDurableSession(parked.sessionState).state)[0]!;
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
    fixture.updateSession((session) => {
      const state = markApprovalCandidateAuthorizationRequired({
        state: session.state,
        candidateId: candidate.candidateId,
        authorizationChallenges: challenges,
      });
      const signIns = withSignIns(readHitlState(state).signIns, challenges);
      return { ...session, state: writeHitlState({ state }, { signIns }).state };
    });
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
    expect(fixture.policyTurns).toEqual([batch.event.turnId]);
    expect(fixture.response).toHaveBeenCalledOnce();
    expect(fixture.fetch).toHaveBeenCalledOnce();
    // The approval held its turn, so the responder's sign-in resumes it without starting another.
    const events = fixture.events.slice(start);
    expect(events.some((event) => event.type === "authorization.completed")).toBe(true);
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(0);
  });

  it.each([false, true])(
    "approves and executes a connection tool with a cold callback cache: %s",
    async (cold) => {
      const fixture = setup();
      await fixture.step({
        delivery: { kind: "deliver", payloads: [{ message: "Save hello in notes." }] },
      });
      const parked = await fixture.step();
      const request = suspendedSteps(readDurableSession(parked.sessionState).state)[0]!
        .requests[0]!;
      expect(request.action.toolName).toBe("notes__saveNote");
      expect(request.prompt).toBe("Approve Notes: Save note?");
      expect(
        fixture.events.flatMap((event) =>
          event.type === "actions.requested"
            ? Object.values(event.data.presentation ?? {}).map((entry) => entry.label)
            : [],
        ),
      ).toContain("Notes: Save note");
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
      // Bob supplies consent; the connection request still uses Alice's credentials.
      expect(callerHeader(fixture.fetch.mock.calls[0])).toBe("alice");
      expect(suspendedSteps(readDurableSession(resumed.sessionState).state)).toEqual([]);
      expect(resumed.serializedContext).not.toHaveProperty("eve.pendingConnectionCalls");
      expect(fixture.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          type: "action.result",
          data: expect.objectContaining({
            status: "completed",
            result: expect.objectContaining({
              callId: request.action.callId,
              output: { body: { saved: true }, status: 200, statusText: "" },
              toolName: "notes__saveNote",
            }),
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
    const request = suspendedSteps(readDurableSession(parked.sessionState).state)[0]!.requests[0]!;
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
    const request = suspendedSteps(readDurableSession(parked.sessionState).state)[0]!.requests[0]!;
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

/** The result the model read back for `callId` on its latest request. */
function modelToolResult(fixture: ReturnType<typeof setup>, callId: string): unknown {
  const [options] = fixture.doStream.mock.calls.at(-1)! as [
    { prompt: { content: unknown; role: string }[] },
  ];
  return options.prompt
    .flatMap((message) =>
      message.role === "tool" ? (message.content as { toolCallId: string }[]) : [],
    )
    .find((part) => part.toolCallId === callId);
}

function callerHeader(call: readonly unknown[] | undefined): string | null {
  const [input, init] = (call ?? []) as [Request | string | URL, RequestInit | undefined];
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  return headers.get("x-caller");
}

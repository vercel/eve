import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import { INTERNAL_CHANNEL_DELIVER } from "#channel/channel-operations.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type { CapabilityRuntime, CapabilitySubagent } from "#execution/capability-session.js";
import { buildInvocationAttributes } from "#internal/invocation/metadata.js";
import { MCP_PROTOCOL_VERSION } from "#internal/mcp/streamable-http-server.js";
import { attachRouteCapabilityRuntime } from "#internal/nitro/routes/channel-route-context.js";
import type { ResolvedSkillDefinition, ResolvedToolDefinition } from "#runtime/types.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { ToolContext } from "#tools/definition.js";
import { toInputSchema } from "#tools/schema.js";
import {
  encodeForwardedPrincipalHeader,
  FORWARDED_PRINCIPAL_HEADER,
  mcpCapabilitiesChannel,
  type TrustedForwarders,
} from "#public/channels/mcp.js";
import type { AuthFn } from "#public/channels/auth.js";

// Subagent calls run as durable task sessions; this in-memory world stands in
// for the workflow runs they create.
interface FakeRun {
  readonly attributes: Record<string, string>;
  readonly createdAt: Date;
  events: unknown[];
  output?: unknown;
  readonly runId: string;
  status: string;
}
const world = vi.hoisted(() => ({ runs: new Map<string, FakeRun>() }));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRun: (runId: string) => {
    const run = world.runs.get(runId)!;
    return {
      async cancel() {
        run.status = "cancelled";
      },
      get returnValue() {
        return Promise.resolve({ output: run.output });
      },
      getReadable: () => eventStream(run.events),
    };
  },
  getWorld: async () => ({ runs: { get: async (runId: string) => world.runs.get(runId) } }),
}));

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

const allowPrincipal: AuthFn<Request> = async () => principal;

describe("mcpCapabilitiesChannel", () => {
  it("fails closed when auth is omitted", () => {
    expect(() => mcpCapabilitiesChannel({} as never)).toThrow(
      "mcpCapabilitiesChannel requires auth",
    );
  });

  it("registers the capabilities route and the authorization callback routes", () => {
    const channel = mcpCapabilitiesChannel({ auth: allowPrincipal });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /eve/v1/mcp-capabilities",
      "GET /eve/v1/mcp-capabilities/authorize/:name/:attemptId",
      "POST /eve/v1/mcp-capabilities/authorize/:name/:attemptId",
    ]);
  });

  it("answers server/discover and prewarms the session sandbox", async () => {
    const harness = createHarness();
    const discover = await harness.call("server/discover", {}, { session: "v2:parent-1" });
    expect(discover.result).toMatchObject({
      _meta: { "eve.dev/sandbox": "warming" },
      capabilities: { resources: {}, tools: {} },
      instructions: "Answers data questions.",
    });
    await Promise.all(harness.waitUntil.mock.calls.map(([task]) => task));
    expect(harness.sandboxOpens()).toBe(1);

    const again = await harness.call("server/discover", {}, { session: "v2:parent-1" });
    expect(again.result).toMatchObject({ _meta: { "eve.dev/sandbox": "ready" } });

    const keyless = await harness.call("server/discover", {});
    expect(keyless.result).toMatchObject({ _meta: { "eve.dev/sandbox": "none" } });
  });

  it("lists exposed tools with owner and approval metadata", async () => {
    const harness = createHarness();
    const listed = await harness.call("tools/list", {});
    const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "sandbox_note",
      "explode",
      "deploy",
      "summarize",
      "needs_sign_in",
      "whoami",
      "review_ai",
    ]);
    expect(tools[2]).toMatchObject({
      _meta: { "eve.dev/approval": true, "eve.dev/owner": "d0" },
      inputSchema: { properties: { env: { type: "string" } }, type: "object" },
    });
    expect(tools[0]).toMatchObject({ _meta: { "eve.dev/approval": false } });
  });

  it("runs tools server-side with session identity, auth, and one reused sandbox", async () => {
    const harness = createHarness();
    const first = await harness.callTool("sandbox_note", { text: "hello" }, "v2:parent-1");
    expect(first.result).toMatchObject({
      structuredContent: { principal: "user-1", previous: null, written: "hello" },
    });
    const sessionId = (first.result as { structuredContent: { sessionId: string } })
      .structuredContent.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);

    const second = await harness.callTool("sandbox_note", { text: "again" }, "v2:parent-1");
    expect(second.result).toMatchObject({
      structuredContent: { previous: "hello", sessionId, written: "again" },
    });
    expect(harness.sandboxOpens()).toBe(1);

    const other = await harness.callTool("sandbox_note", { text: "x" }, "v2:parent-2");
    expect(other.result).toMatchObject({ structuredContent: { previous: null } });
    expect(
      (other.result as { structuredContent: { sessionId: string } }).structuredContent.sessionId,
    ).not.toBe(sessionId);
  });

  it("runs as the route-auth caller when no forwarded principal is sent", async () => {
    const harness = createHarness({ trustedForwarders: () => true });
    const direct = await harness.callTool("whoami", {}, "v2:parent-1");
    expect(direct.status).toBe(200);
    expect(direct.result).toMatchObject({
      structuredContent: { current: principal, initiator: principal },
    });
    const { current } = (direct.result as { structuredContent: { current: SessionAuthContext } })
      .structuredContent;
    expect(current.attributes).not.toHaveProperty("eve:forwarded-by");
  });

  it("deletes ephemeral sandboxes when no session key is sent", async () => {
    const harness = createHarness();
    await harness.callTool("sandbox_note", { text: "once" });
    await Promise.all(harness.waitUntil.mock.calls.map(([task]) => task));
    expect(harness.sandboxDeletes()).toBe(1);
  });

  it("maps toModelOutput to content, objects to structuredContent, and throws to isError", async () => {
    const harness = createHarness();
    const summarized = await harness.callTool("summarize", { topic: "q3" });
    expect(summarized.result).toMatchObject({
      content: [{ text: "Summary of q3", type: "text" }],
      structuredContent: { rows: 3, topic: "q3" },
    });

    const failed = await harness.callTool("explode", {});
    expect(failed.result).toMatchObject({
      content: [{ text: expect.stringContaining("warehouse unavailable"), type: "text" }],
      isError: true,
    });

    const invalid = await harness.callTool("summarize", { topic: 7 });
    expect(invalid.result).toMatchObject({
      content: [{ text: expect.stringContaining("Invalid arguments for summarize") }],
      isError: true,
    });

    const unknown = await harness.callTool("load_skill", {});
    expect(unknown.result).toMatchObject({ isError: true });
  });

  it("round-trips approval through an input-required result", async () => {
    const harness = createHarness();
    const first = await harness.callTool("deploy", { env: "preview" }, "v2:parent-1");
    const pending = first.result as {
      inputRequests: Record<string, { method: string; params: Record<string, unknown> }>;
      requestState: string;
      resultType: string;
    };
    expect(pending.resultType).toBe("input_required");
    expect(pending.inputRequests.approval).toMatchObject({
      method: "elicitation/create",
      params: { mode: "form" },
    });
    expect(harness.deployed).toEqual([]);

    const tampered = await harness.callTool("deploy", { env: "production" }, "v2:parent-1", {
      inputResponses: { approval: { action: "accept", content: { approved: true } } },
      requestState: pending.requestState,
    });
    expect(tampered.result).toMatchObject({ isError: true });
    expect(harness.deployed).toEqual([]);

    const declined = await harness.callTool("deploy", { env: "preview" }, "v2:parent-1", {
      inputResponses: { approval: { action: "decline" } },
      requestState: pending.requestState,
    });
    expect(declined.result).toMatchObject({ isError: true });

    const approved = await harness.callTool("deploy", { env: "preview" }, "v2:parent-1", {
      inputResponses: { approval: { action: "accept", content: { approved: true } } },
      requestState: pending.requestState,
    });
    expect(approved.result).toMatchObject({ content: [{ text: "deployed preview" }] });
    expect(harness.deployed).toEqual(["preview"]);
  });

  it("returns URL elicitation for interactive sign-in and completes it on retry", async () => {
    const harness = createHarness();
    const first = await harness.callTool("needs_sign_in", {}, "v2:parent-1");
    const pending = first.result as {
      inputRequests: Record<string, { params: { mode: string; url: string } }>;
      requestState: string;
    };
    const [request] = Object.values(pending.inputRequests);
    expect(request?.params).toMatchObject({ mode: "url", url: "https://idp.example/authorize" });
    const callbackUrl = harness.lastCallbackUrl();
    expect(callbackUrl).toMatch(
      /^https:\/\/agent\.example\/eve\/v1\/mcp-capabilities\/authorize\/needs_sign_in__inline_auth\/[0-9A-Z]{26}$/,
    );

    const callbackRoute = harness.channel.routes[1]!;
    if (callbackRoute.transport === "websocket") throw new Error("expected HTTP route");
    const [, , , , , name, attemptId] = new URL(callbackUrl!).pathname.split("/");
    const landing = await callbackRoute.handler(new Request(`${callbackUrl}?code=abc`), {
      ...harness.routeArgs(),
      params: { attemptId: attemptId!, name: name! },
    });
    expect(landing.status).toBe(200);

    const retried = await harness.callTool("needs_sign_in", {}, "v2:parent-1", {
      requestState: pending.requestState,
    });
    expect(retried.result).toMatchObject({ content: [{ text: "token:code-abc" }] });
  });

  it("serves skills as resources and rejects traversal", async () => {
    const harness = createHarness();
    const listed = await harness.call("resources/list", {});
    expect(listed.result).toMatchObject({
      resources: [
        {
          _meta: {
            "eve.dev/files": ["references/guide.md"],
            "eve.dev/kind": "skill",
            "eve.dev/owner": "d0",
          },
          description: "Investigate a metric drop.",
          mimeType: "text/markdown",
          name: "triage",
          uri: "skill://d0/triage",
        },
      ],
    });

    const templates = await harness.call("resources/templates/list", {});
    expect(templates.result).toMatchObject({
      resourceTemplates: [{ uriTemplate: "skill://d0/{skill}/{+path}" }],
    });

    const skill = await harness.readResource("skill://d0/triage");
    expect(skill.result).toMatchObject({
      contents: [{ mimeType: "text/markdown", text: "# Triage\nCheck the guide." }],
    });
    const file = await harness.readResource("skill://d0/triage/references/guide.md");
    expect(file.result).toMatchObject({ contents: [{ text: "Step 1: look." }] });

    for (const uri of [
      "skill://d0/triage/../secrets.txt",
      "skill://d0/triage/references/%2E%2E/%2E%2E/etc/passwd",
      "skill://d0/triage/references%2Fguide.md",
      "skill://d0/triage/unlisted.md",
      "skill://sre/triage",
      "skill://d0/missing",
    ]) {
      const rejected = await harness.readResource(uri);
      expect(rejected.error, uri).toMatchObject({ code: -32_602 });
    }
  });
});

describe("mcpCapabilitiesChannel forwarded principal", () => {
  const alice: SessionAuthContext = {
    attributes: { "eve:forwarded-by": "mallory", team_id: "T1" },
    authenticator: "slack-webhook",
    issuer: "slack",
    principalId: "U_ALICE",
    principalType: "user",
  };
  const bob: SessionAuthContext = {
    attributes: {},
    authenticator: "slack-webhook",
    issuer: "slack",
    principalId: "U_BOB",
    principalType: "user",
  };
  const carol: SessionAuthContext = { ...bob, principalId: "U_CAROL" };
  const trustUser1: TrustedForwarders = (forwarder) => forwarder.principalId === "user-1";
  const forwarding = (current: SessionAuthContext, initiator?: SessionAuthContext) => ({
    headers: {
      [FORWARDED_PRINCIPAL_HEADER]: encodeForwardedPrincipalHeader(
        initiator === undefined ? { current } : { current, initiator },
      ),
    },
  });

  it("runs a trusted forwarder's call as the stamped forwarded principals", async () => {
    const harness = createHarness({ trustedForwarders: trustUser1 });
    const forwarded = await harness.callTool("whoami", {}, "v2:p", forwarding(alice, carol));
    expect(forwarded.status).toBe(200);
    expect(forwarded.result).toMatchObject({
      structuredContent: {
        // The sender-supplied eve:forwarded-by is overwritten with the verified forwarder.
        current: { ...alice, attributes: { "eve:forwarded-by": "user-1", team_id: "T1" } },
        initiator: { ...carol, attributes: { "eve:forwarded-by": "user-1" } },
      },
    });

    const currentOnly = await harness.callTool("whoami", {}, "v2:p", forwarding(bob));
    expect(currentOnly.result).toMatchObject({
      structuredContent: {
        current: { principalId: "U_BOB", attributes: { "eve:forwarded-by": "user-1" } },
        initiator: { principalId: "U_BOB", attributes: { "eve:forwarded-by": "user-1" } },
      },
    });
  });

  it("rejects forwarding by an untrusted caller or on a channel without trustedForwarders", async () => {
    const refused = createHarness({ trustedForwarders: () => false });
    const untrusted = await refused.callTool("whoami", {}, "v2:p", forwarding(alice));
    expect(untrusted).toMatchObject({
      error: "Caller is not authorized to assert a forwarded principal.",
      status: 403,
    });
    expect(untrusted.result).toBeUndefined();

    const unconfigured = createHarness();
    const rejected = await unconfigured.callTool("whoami", {}, "v2:p", forwarding(alice));
    expect(rejected).toMatchObject({
      error: "This deployment does not accept a forwarded principal.",
      status: 403,
    });
  });

  it("rejects a malformed forwarded principal header with 400", async () => {
    const harness = createHarness({ trustedForwarders: trustUser1 });
    const cases: Array<[string, string]> = [
      ["not base64url!", "must be base64url-encoded JSON"],
      [Buffer.from("{not json").toString("base64url"), "must decode to UTF-8 JSON"],
      [
        encodeForwardedPrincipalHeader({ current: { ...alice, principalId: "" } }),
        "forwardedPrincipal.current.principalId",
      ],
      [
        Buffer.from(JSON.stringify({ current: alice, token: "secret" })).toString("base64url"),
        "Invalid forwardedPrincipal metadata",
      ],
    ];
    for (const [header, message] of cases) {
      const response = await harness.callTool("whoami", {}, "v2:p", {
        headers: { [FORWARDED_PRINCIPAL_HEADER]: header },
      });
      expect(response.status, header).toBe(400);
      expect(response.error, header).toEqual(
        expect.stringContaining(`Invalid ${FORWARDED_PRINCIPAL_HEADER} header: `),
      );
      expect(response.error, header).toEqual(expect.stringContaining(message));
    }
  });

  it("separates sessions and sandboxes per forwarded user behind one forwarder", async () => {
    const harness = createHarness({ trustedForwarders: trustUser1 });
    const aliceFirst = await harness.callTool(
      "sandbox_note",
      { text: "alice" },
      "v2:shared",
      forwarding(alice),
    );
    const bobFirst = await harness.callTool(
      "sandbox_note",
      { text: "bob" },
      "v2:shared",
      forwarding(bob),
    );
    const aliceAgain = await harness.callTool(
      "sandbox_note",
      { text: "alice-2" },
      "v2:shared",
      forwarding(alice),
    );
    const direct = await harness.callTool("sandbox_note", { text: "direct" }, "v2:shared");
    const read = (response: { result?: unknown }) =>
      (response.result as { structuredContent: { previous: string | null; sessionId: string } })
        .structuredContent;

    expect(read(bobFirst).previous).toBeNull();
    expect(read(aliceAgain).previous).toBe("alice");
    expect(read(direct).previous).toBeNull();
    expect(
      new Set([read(aliceFirst).sessionId, read(bobFirst).sessionId, read(direct).sessionId]).size,
    ).toBe(3);

    const key = (auth: SessionAuthContext) =>
      JSON.stringify([
        auth.authenticator,
        auth.issuer ?? null,
        auth.principalType,
        auth.principalId,
      ]);
    expect(read(aliceFirst).sessionId).toBe(
      createHash("sha256")
        .update(`${key(principal)}\n${key(alice)}\n${harness.sessionKey("v2:shared")}`)
        .digest("hex"),
    );
    expect(read(direct).sessionId).toBe(
      createHash("sha256")
        .update(`${key(principal)}\n${harness.sessionKey("v2:shared")}`)
        .digest("hex"),
    );
  });
});

describe("mcpCapabilitiesChannel subagents", () => {
  const alice: SessionAuthContext = {
    attributes: {},
    authenticator: "slack-webhook",
    principalId: "U_ALICE",
    principalType: "user",
  };
  const complete = (output: string) => (run: FakeRun) => {
    run.status = "completed";
    run.output = output;
  };

  it("lists each declared subagent as a message-taking tool", async () => {
    const listed = await createHarness().call("tools/list", {});
    const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.at(-1)).toEqual({
      _meta: { "eve.dev/approval": false, "eve.dev/kind": "subagent", "eve.dev/owner": "d0" },
      description: expect.stringContaining("Reviews prose for AI patterns."),
      inputSchema: {
        additionalProperties: false,
        properties: { message: { description: expect.any(String), type: "string" } },
        required: ["message"],
        type: "object",
      },
      name: "review_ai",
    });
  });

  it("runs a subagent to completion as the forwarded user in the session's sandbox", async () => {
    const harness = createHarness({
      onSubagentStart: complete("## AI pattern review\n\n**Verdict**: Blocked"),
      trustedForwarders: () => true,
    });
    const forwarded = {
      headers: {
        [FORWARDED_PRINCIPAL_HEADER]: encodeForwardedPrincipalHeader({ current: alice }),
      },
    };
    const called = await harness.callTool(
      "review_ai",
      { message: "/review ai In today's fast-paced world..." },
      "v2:parent-1",
      forwarded,
    );

    expect(called.result).toMatchObject({
      content: [{ text: "## AI pattern review\n\n**Verdict**: Blocked", type: "text" }],
    });
    const [start] = harness.subagentStarts;
    expect(start?.input).toMatchObject({
      auth: { attributes: { "eve:forwarded-by": "user-1" }, principalId: "U_ALICE" },
      capabilities: { requestInput: true },
      initiatorAuth: { principalId: "U_ALICE" },
      input: {
        message: expect.stringMatching(
          /^You are the subagent "review_ai"\.[\s\S]*\/review ai In today's fast-paced world\.\.\.$/,
        ),
      },
      mode: "task",
    });
    // The same capability session id that keys the caller's tool sandbox.
    const sandbox = await harness.callTool("sandbox_note", { text: "x" }, "v2:parent-1", forwarded);
    expect(start?.sandboxSessionId).toBe(
      (sandbox.result as { structuredContent: { sessionId: string } }).structuredContent.sessionId,
    );

    await harness.callTool("review_ai", { message: "again" });
    expect(harness.subagentStarts[1]?.sandboxSessionId).toBeUndefined();
  });

  it("relays a subagent question as input_required and resumes with the answer", async () => {
    const harness = createHarness({
      onSubagentAnswered: complete("Reviewed the changelog."),
      onSubagentStart: (run) => {
        run.events = [
          {
            data: {
              requests: [
                {
                  action: { callId: "q1", input: {}, kind: "tool-call", toolName: "ask_question" },
                  kind: "question",
                  options: [
                    { id: "changelog", label: "Changelog" },
                    { id: "blog", label: "Blog post" },
                  ],
                  prompt: "Which content type is this?",
                  requestId: "q1",
                },
              ],
              sequence: 0,
              stepIndex: 0,
              turnId: "turn_0",
            },
            meta: { at: "2026-09-24T00:00:00.000Z", id: "evt_q" },
            type: "input.requested",
          },
        ];
      },
    });
    const args = { message: "Review this draft." };
    const first = await harness.callTool("review_ai", args, "v2:parent-1");
    const pending = first.result as {
      inputRequests: Record<string, { params: Record<string, unknown> }>;
      requestState: string;
      resultType: string;
    };
    expect(pending.resultType).toBe("input_required");
    const [[requestId, request]] = Object.entries(pending.inputRequests) as [
      [string, { params: Record<string, unknown> }],
    ];
    expect(request.params).toMatchObject({
      message: "Which content type is this?",
      mode: "form",
      requestedSchema: {
        properties: { optionId: { enum: ["changelog", "blog"], type: "string" } },
      },
    });

    const mismatched = await harness.callTool("review_ai", { message: "other" }, "v2:parent-1", {
      inputResponses: {},
      requestState: pending.requestState,
    });
    expect(mismatched.result).toMatchObject({ isError: true });

    const resumed = await harness.callTool("review_ai", args, "v2:parent-1", {
      inputResponses: { [requestId]: { action: "accept", content: { optionId: "changelog" } } },
      requestState: pending.requestState,
    });
    expect(resumed.result).toMatchObject({
      content: [{ text: "Reviewed the changelog.", type: "text" }],
    });
    expect(harness.deliveries).toEqual([
      {
        payload: { inputResponses: [{ optionId: "changelog", requestId: "q1" }] },
        token: harness.subagentStarts[0]?.input.continuationToken,
      },
    ]);
    expect(harness.subagentStarts).toHaveLength(1);
  });

  it("cancels a subagent that outlives the wait and says so", async () => {
    vi.useFakeTimers();
    try {
      let started: FakeRun | undefined;
      const harness = createHarness({ onSubagentStart: (run) => (started = run) });
      const pending = harness.callTool("review_ai", { message: "Review a book." }, "v2:parent-1");
      await vi.advanceTimersByTimeAsync(151_000);
      const called = await pending;
      expect(called.result).toMatchObject({
        content: [
          {
            text: "review_ai did not finish within 150 seconds and was cancelled. Retry with a narrower task.",
          },
        ],
        isError: true,
      });
      expect(harness.subagentCancels).toEqual([started?.runId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits past an interim reply while the subagent's own background work runs", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        onSubagentStart: (run) => {
          // The subagent's first turn yielded while its background task worked: its interim
          // reply is on the stream, but the task-mode session is still open.
          run.events = [
            {
              data: {
                finishReason: "stop",
                message: "The AI-text detection review is running on your pasted text now.",
                sequence: 0,
                stepIndex: 0,
                turnId: "turn_0",
              },
              meta: { at: "2026-09-24T00:00:00.000Z", id: "evt_ack" },
              type: "message.completed",
            },
          ];
          setTimeout(() => complete("## AI pattern review\n\n**Verdict**: Blocked")(run), 5_000);
        },
      });
      const pending = harness.callTool("review_ai", { message: "Review this." }, "v2:parent-1");
      await vi.advanceTimersByTimeAsync(7_000);
      const called = await pending;
      expect(called.result).toMatchObject({
        content: [{ text: "## AI pattern review\n\n**Verdict**: Blocked", type: "text" }],
      });
      expect(harness.subagentCancels).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createHarness(
  options: {
    readonly onSubagentAnswered?: (run: FakeRun) => void;
    readonly onSubagentStart?: (run: FakeRun) => void;
    readonly trustedForwarders?: TrustedForwarders;
  } = {},
) {
  const files = new Map<string, Map<string, string>>();
  let opens = 0;
  let deletes = 0;
  const deployed: string[] = [];
  let callbackUrl: string | undefined;

  const openSandbox = async (sessionId: string): Promise<SandboxAccess> => {
    let opened = false;
    const sandbox = {
      async readTextFile({ path }: { path: string }) {
        return files.get(sessionId)?.get(path) ?? null;
      },
      async writeTextFile({ content, path }: { content: string; path: string }) {
        const sessionFiles = files.get(sessionId) ?? new Map<string, string>();
        sessionFiles.set(path, content);
        files.set(sessionId, sessionFiles);
      },
    };
    return {
      async captureState() {
        return {
          session: opened
            ? { providerName: "memory", state: { sessionId }, stateProtocolVersion: 1 }
            : null,
        };
      },
      async delete() {
        deletes++;
        files.delete(sessionId);
      },
      async get() {
        if (!opened) {
          opened = true;
          opens++;
        }
        return sandbox as never;
      },
      async stop() {},
    };
  };

  const signIn = {
    async completeAuthorization(options: { callback: { params: Record<string, string> } }) {
      return { token: `code-${options.callback.params.code ?? "none"}` };
    },
    async getToken(): Promise<never> {
      throw new ConnectionAuthorizationRequiredError("example");
    },
    principalType: "user",
    async startAuthorization(options: { callbackUrl: string }) {
      callbackUrl = options.callbackUrl;
      return { challenge: { url: "https://idp.example/authorize" } };
    },
  };

  const tools = [
    tool({
      execute: async (input: { text: string }, ctx: ToolContext) => {
        const sandbox = await ctx.getSandbox();
        const previous = await sandbox.readTextFile({ path: "/workspace/note.txt" });
        await sandbox.writeTextFile({ content: input.text, path: "/workspace/note.txt" });
        return {
          previous,
          principal: ctx.session.auth.current?.principalId ?? null,
          sessionId: ctx.session.id,
          written: input.text,
        };
      },
      inputSchema: z.object({ text: z.string() }),
      name: "sandbox_note",
    }),
    tool({
      execute: async () => {
        throw new Error("warehouse unavailable");
      },
      inputSchema: z.object({}),
      name: "explode",
    }),
    tool({
      approval: () => true,
      execute: async (input: { env: string }) => {
        deployed.push(input.env);
        return `deployed ${input.env}`;
      },
      inputSchema: z.object({ env: z.string() }),
      name: "deploy",
    }),
    tool({
      execute: async (input: { topic: string }) => ({ rows: 3, topic: input.topic }),
      inputSchema: z.object({ topic: z.string() }),
      name: "summarize",
      toModelOutput: (output: unknown) => ({
        type: "text",
        value: `Summary of ${(output as { topic: string }).topic}`,
      }),
    }),
    tool({
      execute: async (_input: unknown, ctx: ToolContext) =>
        `token:${(await ctx.getToken(signIn as never)).token}`,
      inputSchema: z.object({}),
      name: "needs_sign_in",
    }),
    tool({
      execute: async (_input: unknown, ctx: ToolContext) => ({
        current: ctx.session.auth.current,
        initiator: ctx.session.auth.initiator,
        sessionId: ctx.session.id,
      }),
      inputSchema: z.object({}),
      name: "whoami",
    }),
  ];

  const skills: ResolvedSkillDefinition[] = [
    {
      description: "Investigate a metric drop.",
      fileIndex: ["references/guide.md"],
      logicalPath: "skills/triage/SKILL.md",
      markdown: "# Triage\nCheck the guide.",
      name: "triage",
      sourceId: "skills/triage",
      sourceKind: "markdown",
    },
  ];

  const subagentStarts: {
    readonly input: Parameters<CapabilitySubagent["createSession"]>[0];
    readonly sandboxSessionId: string | undefined;
  }[] = [];
  const subagentCancels: string[] = [];
  const reviewer: CapabilitySubagent = {
    async createSession(input, sandboxSessionId) {
      subagentStarts.push({ input, sandboxSessionId });
      const run: FakeRun = {
        attributes: { ...buildInvocationAttributes(input.externalInvocation!) },
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
        events: [],
        runId: `wrun_${crypto.randomUUID()}`,
        status: "running",
      };
      world.runs.set(run.runId, run);
      options.onSubagentStart?.(run);
      return { events: new ReadableStream(), sessionId: run.runId };
    },
    async cancel(sessionId) {
      subagentCancels.push(sessionId);
      world.runs.get(sessionId)!.status = "cancelled";
    },
    description: "Reviews prose for AI patterns.",
    name: "review_ai",
  };
  const deliveries: { readonly payload: unknown; readonly token: string }[] = [];
  const from = (token: string) => ({
    async [INTERNAL_CHANNEL_DELIVER](payload: unknown) {
      deliveries.push({ payload, token });
      const run = [...world.runs.values()].find(
        (candidate) => candidate.attributes["$eve.invocation_token"] === token,
      );
      if (run !== undefined) options.onSubagentAnswered?.(run);
    },
  });

  const runtime: CapabilityRuntime = {
    agentName: "d0",
    description: "Answers data questions.",
    hasSandbox: true,
    openSandbox,
    async readSkillFile(skillName, path) {
      return skillName === "triage" && path === "references/guide.md"
        ? new TextEncoder().encode("Step 1: look.")
        : undefined;
    },
    skills,
    subagents: [reviewer],
    tools,
  };

  const channel = mcpCapabilitiesChannel({
    auth: allowPrincipal,
    trustedForwarders: options.trustedForwarders,
  });
  const postRoute = channel.routes[0]!;
  if (postRoute.transport === "websocket") throw new Error("expected HTTP route");
  const handlePost = postRoute.handler;
  const waitUntil = vi.fn<(task: Promise<unknown>) => void>();

  const routeArgs = (): RouteHandlerArgs => {
    const unavailable = () => {
      throw new Error("Route operation is unavailable in this test.");
    };
    return attachRouteCapabilityRuntime(
      {
        attachSession: unavailable,
        from: from as never,
        params: {},
        requestIp: "127.0.0.1",
        resolveSession: vi.fn(),
        to: unavailable,
        waitUntil,
      },
      async () => runtime,
    );
  };

  let nextId = 1;
  const sessionPrefix = crypto.randomUUID();
  async function call(
    method: string,
    params: Record<string, unknown>,
    options: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly name?: string;
      readonly session?: string;
    } = {},
  ): Promise<{ error?: unknown; result?: unknown; status: number }> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "agent.example",
      "mcp-method": method,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (options.name !== undefined) headers["mcp-name"] = options.name;
    // The sandbox cache is process-wide; keep each harness's sessions distinct.
    if (options.session !== undefined) {
      headers["eve-capability-session"] = sessionKey(options.session);
    }
    Object.assign(headers, options.headers);
    const response = await handlePost(
      new Request("https://agent.example/eve/v1/mcp-capabilities", {
        body: JSON.stringify({
          id: nextId++,
          jsonrpc: "2.0",
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: { form: {}, url: {} },
              },
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            },
          },
        }),
        headers,
        method: "POST",
      }),
      routeArgs(),
    );
    if (!(response instanceof Response)) throw new Error("expected an HTTP response");
    const body = (await response.json()) as { error?: unknown; result?: unknown };
    return { ...body, status: response.status };
  }
  function sessionKey(session: string): string {
    return `${sessionPrefix}:${session}`;
  }

  return {
    call,
    async callTool(
      name: string,
      args: Record<string, unknown>,
      session?: string,
      retry: {
        headers?: Record<string, string>;
        inputResponses?: Record<string, unknown>;
        requestState?: string;
      } = {},
    ) {
      const { headers, ...params } = retry;
      return await call(
        "tools/call",
        { arguments: args, name, ...params },
        { headers, name, session },
      );
    },
    channel,
    deliveries,
    deployed,
    lastCallbackUrl: () => callbackUrl,
    async readResource(uri: string) {
      return await call("resources/read", { uri }, { name: uri });
    },
    routeArgs,
    sandboxDeletes: () => deletes,
    sandboxOpens: () => opens,
    sessionKey,
    subagentCancels,
    subagentStarts,
    waitUntil,
  };
}

function tool(input: {
  readonly approval?: () => boolean;
  readonly execute: (input: never, ctx: ToolContext) => unknown;
  readonly inputSchema: z.ZodType;
  readonly name: string;
  readonly toModelOutput?: (output: unknown) => unknown;
}): ResolvedToolDefinition {
  return {
    approval: input.approval,
    description: `The ${input.name} tool.`,
    // Authored executors receive the tool context as their second argument.
    execute: ((toolInput: unknown, ctx: unknown) =>
      input.execute(toolInput as never, ctx as ToolContext)) as ResolvedToolDefinition["execute"],
    inputSchema: toInputSchema(input.inputSchema),
    logicalPath: `tools/${input.name}.ts`,
    name: input.name,
    owner: { kind: "application" },
    sourceId: `tools/${input.name}`,
    sourceKind: "module",
    toModelOutput: input.toModelOutput as ResolvedToolDefinition["toModelOutput"],
  };
}

function eventStream(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
  return Object.assign(stream, { getTailIndex: async () => events.length - 1 });
}

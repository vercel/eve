import { commitOf } from "#harness/session-machine/commit.js";
import type { DeliverHookPayload } from "#channel/types.js";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { AgentSpanIdGenerator, otelTelemetry } from "#compiled/@vercel/agent-runs/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { eventsOf } from "#harness/publication.js";
import { cascade } from "#harness/session-machine/cascade.js";
import {
  currentView,
  enterSessionProjectionAt,
  nextLinePosition,
  recordPublishedLine,
} from "#harness/session-machine/current.js";
import { ConnectionAuthorizationFailedError } from "#connections/errors.js";
import { createAiSdkHookBridge } from "#instrumentation/ai-sdk-hook-bridge.js";
import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
  type InstrumentationScope,
} from "#instrumentation/lifecycle.js";
import {
  attemptScopeOf,
  createInstrumentationHandleEvent,
  type CreateInstrumentationHandleEventInput,
} from "#instrumentation/native-events.js";
import { InMemoryAgentTraceStateStore } from "#internal/testing/in-memory-agent-trace-state-store.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { createAgentOtelInstrumentation } from "#tracing/eve/agent-otel-provider.js";
import type { TraceCapturePolicy } from "#tracing/eve/otel-declaration.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";

/**
 * The spans a session exports, from its committed lines through eve's own OTel provider: the
 * path production takes, with no hand-built instrumentation events in between.
 */
function session(
  tracePolicy: TraceCapturePolicy = () => ({ emit: true, recordInputs: true, recordOutputs: true }),
  deliveryInput?: DeliverHookPayload,
  child?: Pick<
    CreateInstrumentationHandleEventInput,
    "parentLineage" | "parentTraceContext" | "rootSessionId"
  >,
  audience: ChannelAudience = "public",
  authored: readonly InstrumentationProviderDefinition[] = [],
) {
  const exporter = new InMemorySpanExporter();
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const otel = createAgentOtelInstrumentation({
    environment: "production",
    frameworkVersion: "test",
    idGenerator,
    recordInputs: true,
    recordOutputs: true,
    stateStore: new InMemoryAgentTraceStateStore(),
    telemetry: otelTelemetry({
      idGenerator,
      mapping: eveOutputMapping(),
      provider,
      samplesTrace: () => true,
      tracerName: "eve.agent",
    }),
    tracePolicy,
  });
  const hooks = createInstrumentationHooks([otel.hook, ...authored]).forTrace!({
    agentName: "weather",
    audience,
    channel: { kind: "http" },
    environment: "production",
    principalType: "anonymous",
  });
  const ctx = new ContextContainer();
  enterSessionProjectionAt(ctx, undefined);
  const handleFor = (relayed: boolean) =>
    createInstrumentationHandleEvent({
      deliveryInput,
      agentName: "weather",
      channelAudience: audience,
      channelKind: "http",
      environment: "production",
      functionId: "weather",
      handleEvent: async (publication) => {
        const facts = cascade(currentView(ctx), eventsOf(publication));
        recordPublishedLine(ctx, { at, facts }, nextLinePosition(ctx), facts);
      },
      hooks,
      relayed,
      sessionId: "s",
      ...child,
    })!;
  const handle = handleFor(false);
  const relayHandle = handleFor(true);
  return {
    commit: (...facts: SessionEvent[]) => contextStorage.run(ctx, () => handle(commitOf(facts))),
    /** Commits as a step that relays an exchange for a child session or a workflow run. */
    relay: (...facts: SessionEvent[]) =>
      contextStorage.run(ctx, () => relayHandle(commitOf(facts))),
    /** Runs a tool's `execute` the way the AI SDK bridge does, inside its call's span. */
    runTool: otel.runInContext,
    /** Runs a compaction's summary call for the turn, as its run outside any step reports it. */
    async summarize(summary: string) {
      const scope = attemptScopeOf(
        { channelAudience: audience, functionId: "weather", sessionId: "s", ...child },
        { attempt: 0, runId: "run_compaction", turnId: "turn_0" },
      );
      await generateText({
        model: new MockLanguageModelV3({
          doGenerate: async () => ({
            content: [{ text: summary, type: "text" }],
            finishReason: { raw: undefined, unified: "stop" },
            providerMetadata: { gateway: { cost: "0.0042" } },
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1200, total: 1200 },
              outputTokens: { reasoning: 0, text: 80, total: 80 },
            },
            warnings: [],
          }),
        }),
        prompt: "Summarize Alice's conversation so far.",
        telemetry: {
          integrations: [
            createAiSdkHookBridge(scope, hooks, otel.runInContext, {
              "eve.compaction.request": "summary",
            }),
          ],
          isEnabled: true,
        },
      });
    },
    async spans(): Promise<readonly ReadableSpan[]> {
      await provider.forceFlush();
      return exporter.getFinishedSpans();
    },
  };
}

const at = "2026-10-09T00:00:00.000Z";
const turn = { turnId: "turn_0" };
const run = { runId: "run_0", turnId: "turn_0" };

const opening = [
  { data: {}, type: "session.started" },
  {
    data: { cause: { hook: "h" }, follows: null, turnId: "turn_0" },
    scope: turn,
    type: "turn.started",
  },
  { data: { owner: turn, runId: "run_0" }, scope: run, type: "model.requested" },
  { data: { attempt: 0, modelId: "m", runId: "run_0" }, scope: run, type: "model.started" },
] as SessionEvent[];

const requested = (callId: string, name: string): SessionEvent =>
  ({
    data: { callId, capability: { kind: "tool", name }, input: { city: "Oslo" }, owner: run },
    scope: run,
    type: "call.requested",
  }) as SessionEvent;

const settled = (callId: string, data: Record<string, unknown>): SessionEvent =>
  ({ data: { callId, ...data }, scope: run, type: "call.settled" }) as SessionEvent;

const approval = (callId: string): SessionEvent =>
  ({
    data: {
      interactionId: `i_${callId}`,
      request: {
        kind: "approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        prompt: "Deploy?",
      },
      subject: { callId },
    },
    scope: turn,
    type: "interaction.opened",
  }) as SessionEvent;

const turnSettled = (data: Record<string, unknown>): SessionEvent =>
  ({ data: { turnId: "turn_0", ...data }, scope: turn, type: "turn.settled" }) as SessionEvent;

/** Each span as `name outcome`, indented under its parent; `!` marks an error status. */
function tree(spans: readonly ReadableSpan[]): string[] {
  const ids = new Set(spans.map((span) => span.spanContext().spanId));
  const children = new Map<string | undefined, ReadableSpan[]>();
  for (const span of spans) {
    const parent = span.parentSpanContext?.spanId;
    const key = parent !== undefined && ids.has(parent) ? parent : undefined;
    children.set(key, [...(children.get(key) ?? []), span]);
  }
  const lines: string[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      const outcome =
        span.attributes["agent.turn.outcome"] ??
        span.attributes["agent.action.outcome"] ??
        span.attributes["agent.approval.outcome"];
      const status = span.status.code === 2 ? " !" : "";
      lines.push(
        `${"  ".repeat(depth)}${span.name}${outcome === undefined ? "" : ` ${String(outcome)}`}${status}`,
      );
      walk(span.spanContext().spanId, depth + 1);
    }
  };
  walk(undefined, 0);
  return lines;
}

describe("a session's spans, from its committed lines", () => {
  it.each([
    [1, false],
    [2, false],
    [1, true],
  ] as const)(
    "attributes one message delivery (%i messages, answered: %s)",
    async (count, answered) => {
      const { commit, spans } = session(undefined, {
        kind: "deliver",
        payloads: Array.from({ length: count }, () => ({ message: "Alice's report" })),
        deliveryMetadata: Array.from({ length: count }, (_, index) => ({
          channelKind: "channel:web",
          channelName: "web",
          deliveryId: `d_${index}`,
          payloadIndex: index,
        })),
      });
      await commit(...opening);
      for (let index = 0; index < count; index++) {
        const deliveryId = `d_${index}`;
        await commit(
          { type: "delivery.admitted", data: { deliveryId } },
          {
            type: "delivery.consumed",
            data: {
              deliveryId,
              turnId: "turn_0",
              parts: [{ kind: "text", text: "Alice's report" }],
            },
          },
        );
      }
      if (answered) {
        await commit(requested("call_deploy", "deploy"), approval("call_deploy"));
        await commit(
          { type: "delivery.admitted", data: { deliveryId: "answer" } },
          {
            type: "response.submitted",
            data: {
              deliveryId: "answer",
              responseId: "response",
              interactionId: "i_call_deploy",
              value: { optionId: "approve" },
            },
          },
          {
            type: "delivery.consumed",
            data: { deliveryId: "answer", turnId: "turn_0", parts: [] },
          },
        );
      }
      await commit(turnSettled({ outcome: "completed" }));
      const turn = (await spans()).find((span) => span.name === "invoke_agent weather");
      expect(turn).toBeDefined();
      expect(turn!.attributes["agent.channel.delivery.id"]).toBe(count === 1 ? "d_0" : undefined);
      expect(turn!.attributes["agent.trace.schema.version"]).toBe(4);
    },
  );

  it("exports a turn as one tree: its step, each call, and an approved call's approval", async () => {
    const { commit, spans } = session();
    await commit(...opening);
    await commit(requested("call_weather", "weather"), requested("call_deploy", "deploy"));
    await commit(settled("call_weather", { outcome: "completed", output: { temperature: 4 } }));
    await commit(approval("call_deploy"));
    await commit({
      data: {
        cause: { responseId: "r_0" },
        interactionId: "i_call_deploy",
        outcome: "accepted",
        response: { optionId: "approve" },
      },
      scope: turn,
      type: "interaction.settled",
    } as SessionEvent);
    await commit(settled("call_deploy", { outcome: "completed", output: "deployed" }));
    await commit({
      data: { outcome: "completed", runId: "run_0" },
      scope: run,
      type: "model.settled",
    } as SessionEvent);
    await commit(turnSettled({ outcome: "completed" }));

    expect(tree(await spans())).toEqual([
      "invoke_agent weather completed",
      "  agent.step",
      "    execute_tool weather completed",
      "    execute_tool deploy completed",
      "      agent.approval approved",
    ]);
  });

  it.each([
    ["accepted", "approved"],
    ["declined", "denied"],
    ["withdrawn", "ignored"],
    ["expired", "cancelled"],
    ["abandoned", "cancelled"],
  ] as const)(
    "reports an approval the person %s as %s, the value dashboards query",
    async (outcome, reported) => {
      const { commit, spans } = session();
      await commit(...opening);
      await commit(requested("call_deploy", "deploy"));
      await commit(approval("call_deploy"));
      await commit({
        data: { interactionId: "i_call_deploy", outcome },
        scope: turn,
        type: "interaction.settled",
      } as SessionEvent);
      await commit(turnSettled({ outcome: "completed" }));

      const [span] = (await spans()).filter((each) => each.name === "agent.approval");
      expect(span?.attributes["agent.approval.outcome"]).toBe(reported);
    },
  );

  it.each([
    {
      ask: "a question a call asks",
      request: { kind: "question", prompt: "Which region?" },
      subject: { callId: "call_ask" },
      kind: "question",
      expected: [
        "invoke_agent weather completed",
        "  agent.step",
        "    execute_tool ask_question completed",
        "      agent.approval approved",
      ],
    },
    {
      ask: "a budget prompt",
      request: { kind: "budget", prompt: "Keep going?" },
      subject: turn,
      kind: "budget",
      expected: [
        "invoke_agent weather completed",
        "  agent.approval approved",
        "  agent.step",
        "    execute_tool ask_question completed",
      ],
    },
    {
      ask: "a sign-in the turn needs",
      request: {
        kind: "sign-in",
        prompt: "Sign in to Calendar",
        signIn: { name: "calendar", url: "https://example.com/oauth" },
      },
      subject: turn,
      kind: "sign-in",
      connection: "calendar",
      expected: [
        "invoke_agent weather completed",
        "  agent.approval approved",
        "  agent.step",
        "    execute_tool ask_question completed",
      ],
    },
  ])(
    "records the wait on $ask as an approval span",
    async ({ request, subject, kind, connection, expected }) => {
      const { commit, spans } = session();
      await commit(...opening);
      await commit(requested("call_ask", "ask_question"));
      await commit({
        data: { interactionId: "i_wait", request, subject },
        scope: turn,
        type: "interaction.opened",
      } as SessionEvent);
      await commit({
        data: { interactionId: "i_wait", outcome: "accepted" },
        scope: turn,
        type: "interaction.settled",
      } as SessionEvent);
      await commit(settled("call_ask", { outcome: "completed", output: "eu" }));
      await commit({
        data: { outcome: "completed", runId: "run_0" },
        scope: run,
        type: "model.settled",
      } as SessionEvent);
      await commit(turnSettled({ outcome: "completed" }));

      const exported = await spans();
      expect(tree(exported)).toEqual(expected);
      const span = exported.find((each) => each.name === "agent.approval");
      expect(span?.attributes["agent.approval.kind"]).toBe(kind);
      expect(span?.attributes["eve.connection.name"]).toBe(connection);
      expect(span?.attributes["gen_ai.agent.name"]).toBe("weather");
      expect(JSON.stringify(span?.attributes)).not.toContain("oauth");
    },
  );

  it.each([
    ["a budget prompt", { kind: "budget", prompt: "Keep going?" }],
    ["a sign-in", { kind: "sign-in", prompt: "Sign in to Calendar", signIn: { name: "calendar" } }],
  ])(
    "records %s the turn holds before its first model run, without showing it to other providers",
    async (_, request) => {
      const heard: string[] = [];
      const { commit, spans } = session(undefined, undefined, undefined, undefined, [
        {
          name: "authored",
          events: {
            "interaction.opened": (event) => void heard.push(event.type),
            "interaction.settled": (event) => void heard.push(event.type),
          },
        },
      ]);
      await commit(...opening.slice(0, 2));
      await commit({
        data: { interactionId: "i_held", request, subject: turn },
        scope: turn,
        type: "interaction.opened",
      } as SessionEvent);
      await commit({
        data: { interactionId: "i_held", outcome: "accepted" },
        scope: turn,
        type: "interaction.settled",
      } as SessionEvent);
      await commit(turnSettled({ outcome: "completed" }));

      expect(tree(await spans())).toEqual([
        "invoke_agent weather completed",
        "  agent.approval approved",
      ]);
      // Public scopes name a model run, and none has started.
      expect(heard).toEqual([]);
    },
  );

  it.each([
    ["a failure's reason code", "failed", "access_denied", "access_denied"],
    ["a failure's error message", "failed", "Calendar said: token abc123 is invalid", undefined],
    // Alice sent a new message, so the sign-in ended without anyone refusing it.
    ["a withdrawal's reason", "withdrawn", "superseded-by-message", undefined],
  ])("records an authorization reason for %s", async (_, outcome, reason, recorded) => {
    const { commit, spans } = session();
    await commit(...opening.slice(0, 2));
    await commit({
      data: {
        interactionId: "i_held",
        request: { kind: "sign-in", prompt: "Sign in to Calendar", signIn: { name: "calendar" } },
        subject: turn,
      },
      scope: turn,
      type: "interaction.opened",
    } as SessionEvent);
    await commit({
      data: { interactionId: "i_held", outcome, reason },
      scope: turn,
      type: "interaction.settled",
    } as SessionEvent);
    await commit(turnSettled({ outcome: "completed" }));

    const span = (await spans()).find((each) => each.name === "agent.approval");
    expect(span?.attributes["agent.approval.outcome"]).toBe(
      outcome === "failed" ? "failed" : "ignored",
    );
    expect(span?.attributes["agent.connection.authorization.reason"]).toBe(recorded);
    expect(JSON.stringify(span?.attributes)).not.toContain("abc123");
  });

  it("records which connection refused a call and why, even when the trace keeps no errors", async () => {
    const scopes = new Map<string, InstrumentationScope>();
    const { commit, runTool, spans } = session(
      () => ({ emit: true, recordInputs: false, recordOutputs: false }),
      undefined,
      undefined,
      undefined,
      [
        {
          name: "scopes",
          events: { "call.requested": (event) => void scopes.set(event.callId, event.scope) },
        },
      ],
    );
    await commit(...opening);
    await commit(requested("call_gh", "code__gh"));
    // A turn a schedule started can't ask Alice to sign in, so the call fails without a prompt.
    const refused = new ConnectionAuthorizationFailedError("github", {
      message: "Alice has no GitHub token in this run.",
      reason: "sign_in_unavailable",
      retryable: false,
    });
    await expect(
      runTool(
        {
          callId: "call_gh",
          idempotencyKey: "tool:call_gh",
          scope: scopes.get("call_gh")!,
          toolName: "code__gh",
          type: "tool.call",
        },
        () => Promise.reject(refused),
      ),
    ).rejects.toBe(refused);
    await commit(
      settled("call_gh", {
        error: { code: "ACTION_RESULT_FAILED", message: refused.message, name: refused.name },
        outcome: "failed",
      }),
    );
    await commit(turnSettled({ outcome: "completed" }));

    const tool = (await spans()).find((span) => span.name === "execute_tool code__gh");
    expect(tool?.attributes["eve.connection.name"]).toBe("github");
    expect(tool?.attributes["agent.connection.authorization.reason"]).toBe("sign_in_unavailable");
    expect(JSON.stringify(tool?.attributes)).not.toContain("Alice");
  });

  it.each([
    {
      asker: "a subagent's approval, which its own session records",
      capability: { kind: "agent", name: "researcher" },
      request: { kind: "approval", prompt: "Deploy?" },
      origin: { call: { callId: "c_deploy", name: "deploy" }, sessionId: "child_s" },
      expected: [],
    },
    {
      asker: "a session a workflow run opened, which records its own",
      capability: { kind: "tool", name: "flow" },
      child: "child_w",
      request: { kind: "question", prompt: "Which region?" },
      origin: { sessionId: "child_w" },
      expected: [],
    },
    {
      asker: "a workflow tool's question, such as ask_question",
      capability: { kind: "tool", name: "ask_question" },
      request: { kind: "question", prompt: "Pick a color." },
      origin: { call: { callId: "call_relay", name: "ask_question" }, sessionId: "wrun_0" },
      expected: [["question", "execute_tool ask_question"]],
    },
    {
      asker: "a workflow run's sign-in",
      capability: { kind: "tool", name: "flow" },
      request: { kind: "sign-in", prompt: "Sign in to Calendar", signIn: { name: "calendar" } },
      origin: { sessionId: "wrun_0" },
      expected: [["sign-in", "invoke_agent weather"]],
    },
  ])(
    "records a relayed request once, where it waits: $asker",
    async ({ capability, child, request, origin, expected }) => {
      const { commit, relay, spans } = session();
      await commit(...opening);
      await commit({
        data: { callId: "call_relay", capability, input: {}, owner: run },
        scope: run,
        type: "call.requested",
      } as SessionEvent);
      if (child !== undefined)
        await commit({
          data: { name: "agent", owner: { callId: "call_relay" }, sessionId: child, stream: "s" },
          type: "child.opened",
        } as SessionEvent);
      await relay({
        data: {
          interactionId: "i_relayed",
          origin: { interactionId: "i_relayed", ...origin },
          request,
          subject: { callId: "call_relay" },
        },
        scope: turn,
        type: "interaction.opened",
      } as SessionEvent);
      await relay({
        data: { interactionId: "i_relayed", outcome: "accepted" },
        scope: turn,
        type: "interaction.settled",
      } as SessionEvent);
      await commit(settled("call_relay", { outcome: "completed", output: "done" }));
      await commit(turnSettled({ outcome: "completed" }));

      const exported = await spans();
      const parentName = (id: string | undefined) =>
        exported.find((span) => span.spanContext().spanId === id)?.name;
      expect(
        exported
          .filter((span) => span.name === "agent.approval")
          .map((span) => [
            span.attributes["agent.approval.kind"],
            parentName(span.parentSpanContext?.spanId),
          ]),
      ).toEqual(expected);
    },
  );

  it("records who approved a call on its approval and tool spans, the id only as the turn's principal", async () => {
    for (const { audience, records, id, outcome = "accepted" } of [
      { audience: "public", records: true, id: "slack:T1:U2" },
      { audience: "public", records: false, id: undefined },
      // An explicit policy records a private conversation's content, but never principal ids.
      { audience: "private", records: true, id: undefined },
      // A denied call never runs, so only its approval names who denied it.
      { audience: "public", records: true, id: "slack:T1:U2", outcome: "declined" },
    ] as const) {
      const { commit, spans } = session(
        () => ({ emit: true, recordInputs: records, recordOutputs: records }),
        undefined,
        undefined,
        audience,
      );
      await commit(...opening);
      await commit(requested("call_deploy", "deploy"));
      await commit(approval("call_deploy"));
      await commit(
        {
          data: { deliveryId: "d_approver", principal: { id: "slack:T1:U2", type: "user" } },
          type: "delivery.admitted",
        },
        {
          data: {
            deliveryId: "d_approver",
            interactionId: "i_call_deploy",
            responseId: "r_0",
            value: { optionId: "approve" },
          },
          type: "response.submitted",
        } as SessionEvent,
      );
      await commit({
        data: { cause: { responseId: "r_0" }, interactionId: "i_call_deploy", outcome },
        scope: turn,
        type: "interaction.settled",
      } as SessionEvent);
      await commit(turnSettled({ outcome: "completed" }));

      const exported = await spans();
      const span = exported.find((each) => each.name === "agent.approval");
      expect(span?.attributes["agent.approval.responder.type"]).toBe("user");
      expect(span?.attributes["agent.approval.responder.id"]).toBe(id);
      const tool = exported.find((each) => each.name === "execute_tool deploy");
      expect(tool?.attributes["agent.tool.approver.type"]).toBe(
        outcome === "accepted" ? "user" : undefined,
      );
      expect(tool?.attributes["agent.tool.approver.id"]).toBe(
        outcome === "accepted" ? id : undefined,
      );
    }
  });

  it("ends what a cancelled turn leaves running as cancelled, and a failed call with its code", async () => {
    const { commit, spans } = session();
    await commit(...opening);
    await commit(requested("call_weather", "weather"), requested("call_deploy", "deploy"));
    await commit(
      settled("call_weather", {
        error: { code: "TOOL_FAILED", message: "No such city" },
        outcome: "failed",
      }),
    );
    await commit(approval("call_deploy"));
    await commit(turnSettled({ outcome: "cancelled" }));

    const exported = await spans();
    expect(tree(exported)).toEqual([
      "invoke_agent weather cancelled",
      // The cancel stopped the step on purpose, so it ends without an error (#5025).
      "  agent.step",
      "    execute_tool weather failed !",
      "    execute_tool deploy cancelled !",
      "      agent.approval cancelled",
    ]);
    const failed = exported.find((span) => span.name === "execute_tool weather");
    expect(failed?.attributes["error.type"]).toBe("TOOL_FAILED");
  });

  it("exports a compaction's summary call during a turn as a model span under the turn", async () => {
    const { commit, spans, summarize } = session();
    await commit(...opening);
    await commit({
      data: { outcome: "completed", runId: "run_0" },
      scope: run,
      type: "model.settled",
    } as SessionEvent);
    await summarize("Alice is planning a trip to Oslo.");
    await commit(turnSettled({ outcome: "completed" }));

    const exported = await spans();
    expect(tree(exported)).toEqual([
      "invoke_agent weather completed",
      "  agent.step",
      "  chat mock-model-id",
    ]);
    const summary = exported.find((span) => span.name === "chat mock-model-id");
    expect(summary?.attributes).toMatchObject({
      "agent.turn.id": "turn_0",
      "ai.settings.context.eve.compaction.request": "summary",
      "gen_ai.usage.cost": 0.0042,
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 80,
    });
    // The summary's prompt and reply are not the conversation's, so the turn doesn't take them.
    const invocation = exported.find((span) => span.name === "invoke_agent weather");
    expect(invocation?.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(invocation?.attributes["gen_ai.output.messages"]).toBeUndefined();
  });

  it("fails the step a failed turn's end cuts short", async () => {
    const { commit, spans } = session();
    await commit(...opening);
    await commit(
      turnSettled({
        error: { code: "MODEL_CALL_FAILED", message: "Overloaded" },
        outcome: "failed",
      }),
    );

    expect(tree(await spans())).toEqual(["invoke_agent weather failed !", "  agent.step !"]);
  });

  it("fails the turn a failed session ends, with the session's error", async () => {
    const { commit, spans } = session();
    await commit(...opening);
    await commit({
      data: {
        cause: { turnId: "turn_0" },
        error: { code: "MODEL_CALL_FAILED", message: "Invalid API key" },
        outcome: "failed",
      },
      type: "session.ended",
    } as SessionEvent);

    const [invocation] = (await spans()).filter((span) => span.name === "invoke_agent weather");
    expect(invocation?.attributes["agent.turn.outcome"]).toBe("failed");
    expect(invocation?.status).toMatchObject({ code: 2 });
  });

  it("keeps a call's input and output off its span unless the trace policy records them", async () => {
    for (const records of [false, true]) {
      const { commit, spans } = session(() => ({
        emit: true,
        recordInputs: records,
        recordOutputs: records,
      }));
      await commit(...opening);
      await commit(requested("call_weather", "weather"));
      await commit(settled("call_weather", { outcome: "completed", output: { temperature: 4 } }));
      await commit(turnSettled({ outcome: "completed" }));

      const tool = (await spans()).find((span) => span.name === "execute_tool weather");
      const content = JSON.stringify(tool?.attributes ?? {});
      expect(content.includes("Oslo"), `input recorded: ${records}`).toBe(records);
      expect(content.includes("temperature"), `output recorded: ${records}`).toBe(records);
    }
  });
});

describe("a child session's turn span", () => {
  const caller = { spanId: "c".repeat(16), traceFlags: 1, traceId: "a".repeat(32) };
  // A propagated traceparent arrives as a remote span context.
  const remoteCaller = { ...caller, isRemote: true };
  const parentLineage = {
    callId: "call_ask",
    sessionId: "parent",
    subagentName: "helper",
    turnId: "turn_p",
  };

  async function childTurn(isRemote: boolean) {
    const { commit, spans } = session(undefined, undefined, {
      parentLineage,
      parentTraceContext: isRemote ? remoteCaller : caller,
      rootSessionId: "root",
    });
    await commit(...opening);
    await commit(turnSettled({ outcome: "completed" }));
    const turn = (await spans()).find((span) => span.name === "invoke_agent weather");
    expect(turn?.attributes).toMatchObject({
      "agent.parent_call.id": "call_ask",
      "agent.parent_run.id": "parent",
      "agent.run.id": "s",
      "agent.subagent.name": "helper",
      "gen_ai.conversation.id": "root",
    });
    return turn!;
  }

  it("nests a local child beneath its caller's call in the caller's trace", async () => {
    const turn = await childTurn(false);

    expect(turn.spanContext().traceId).toBe(caller.traceId);
    expect(turn.parentSpanContext?.spanId).toBe(caller.spanId);
    expect(turn.links).toEqual([]);
  });

  it("starts a remote child's own trace and links back to its dispatch", async () => {
    const turn = await childTurn(true);

    expect(turn.spanContext().traceId).not.toBe(caller.traceId);
    expect(turn.parentSpanContext).toBeUndefined();
    expect(turn.links).toEqual([
      expect.objectContaining({
        attributes: { "eve.link.type": "agent.dispatch" },
        context: expect.objectContaining({ spanId: caller.spanId, traceId: caller.traceId }),
      }),
    ]);
  });
});

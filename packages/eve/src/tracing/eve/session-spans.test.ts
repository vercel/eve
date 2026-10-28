import type { DeliverHookPayload } from "#channel/types.js";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
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
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import {
  createInstrumentationHandleEvent,
  type CreateInstrumentationHandleEventInput,
} from "#instrumentation/native-events.js";
import { InMemoryAgentTraceStateStore } from "#internal/testing/in-memory-agent-trace-state-store.js";
import type { SessionEvent } from "#protocol/session-event.js";
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
  const hooks = createInstrumentationHooks([otel.hook]).forTrace!({
    agentName: "weather",
    audience: "public",
    channel: { kind: "http" },
    environment: "production",
    principalType: "anonymous",
  });
  const ctx = new ContextContainer();
  enterSessionProjectionAt(ctx, undefined);
  const handle = createInstrumentationHandleEvent({
    deliveryInput,
    agentName: "weather",
    channelAudience: "public",
    channelKind: "http",
    functionId: "weather",
    handleEvent: async (publication) => {
      const facts = cascade(currentView(ctx), eventsOf(publication));
      recordPublishedLine(ctx, { at, facts }, nextLinePosition(ctx), facts);
    },
    hooks,
    sessionId: "s",
    ...child,
  })!;
  return {
    commit: (...facts: SessionEvent[]) => contextStorage.run(ctx, () => handle(facts)),
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

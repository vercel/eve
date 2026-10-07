import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { context, propagation, trace } from "@opentelemetry/api";
import { createAgentTracing, otelTelemetry } from "@vercel/agent-tracing";
import { createAgentDelegationTransport } from "@vercel/agent-tracing/delegation";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

describe("agent delegation", () => {
  it("inherits local lineage across awaits and isolates parallel calls", async () => {
    const exporter = new InMemorySpanExporter();
    const otel = { spanProcessors: [new SimpleSpanProcessor(exporter)] };
    const provider = new BasicTracerProvider(otel);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const parent = createAgentTracing({
      telemetry: otelTelemetry({ provider }),
    });
    const child = createAgentTracing({
      telemetry: otelTelemetry({ provider }),
    });
    try {
      await parent.turn(
        {
          agentName: "parent",
          identity: { conversationId: "conversation", runId: "parent-run", turnId: "parent-turn" },
          sequence: 0,
        },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
            Promise.all(
              ["alice", "bob"].map((callId) =>
                attempt.callSubAgent({ callId, agentName: "child" }, async () => {
                  await Promise.resolve();
                  await child.turn(
                    {
                      agentName: "child",
                      identity: { conversationId: "ignored", runId: callId, turnId: "first" },
                      sequence: 0,
                    },
                    async () => "done",
                  );
                  await child.turn(
                    {
                      agentName: "child",
                      identity: { conversationId: "ignored", runId: callId, turnId: "second" },
                      sequence: 1,
                    },
                    async () => "done",
                  );
                }),
              ),
            ),
          ),
      );
      const spans = exporter.getFinishedSpans();
      const calls = spans.filter((span) => span.name === "execute_tool child");
      expect(calls).toHaveLength(2);
      for (const callId of ["alice", "bob"]) {
        const turns = spans.filter(
          (span) =>
            span.name === "invoke_agent child" && span.attributes["agent.run.id"] === callId,
        );
        expect(turns).toHaveLength(2);
        const first = turns.find((span) => span.attributes["agent.turn.sequence"] === 0)!;
        const second = turns.find((span) => span.attributes["agent.turn.sequence"] === 1)!;
        expect(first.attributes).toMatchObject({
          "gen_ai.conversation.id": "conversation",
          "agent.parent_run.id": "parent-run",
        });
        // A local child's first turn nests under the call that delegated to it.
        const call = calls.find((span) => span.attributes["gen_ai.tool.call.id"] === callId)!;
        expect(first.parentSpanContext?.spanId).toBe(call.spanContext().spanId);
        expect(first.spanContext().traceId).toBe(call.spanContext().traceId);
        expect(first.links).toHaveLength(0);
        expect(second.parentSpanContext).toBeUndefined();
        expect(second.links).toHaveLength(0);
      }
    } finally {
      await parent.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    }
  });

  it("injects only configured transport calls and accepts only trusted remote handoffs", async () => {
    const exporter = new InMemorySpanExporter();
    const otel = { spanProcessors: [new SimpleSpanProcessor(exporter)] };
    const provider = new BasicTracerProvider(otel);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const caller = createAgentTracing({
      telemetry: otelTelemetry({ provider }),
    });
    const callee = createAgentTracing({
      telemetry: otelTelemetry({ provider }),
    });
    const transport = createAgentDelegationTransport();
    let sent = new Headers();
    const fetcher = transport.transport(async (_request, init) => {
      sent = new Headers(init?.headers);
      return transport.receive(
        sent,
        () => true,
        async () => {
          await callee.turn(
            {
              agentName: "callee",
              identity: { conversationId: "local", runId: "remote-run", turnId: "remote-turn" },
              sequence: 0,
              capture: { emit: true, recordInputs: true, recordOutputs: true },
            },
            async (turn) => {
              expect(turn.capture.recordOutputs).toBe(false);
            },
          );
          return new Response("done");
        },
      );
    });
    try {
      await caller.turn(
        {
          agentName: "caller",
          identity: { conversationId: "conversation", runId: "caller-run", turnId: "turn" },
          sequence: 0,
        },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
            attempt.callRemoteAgent({ callId: "remote", agentName: "callee" }, () =>
              fetcher("https://approved.example/agent", { headers: { "x-app": "kept" } }),
            ),
          ),
      );
      expect(sent.get("x-app")).toBe("kept");
      expect(sent.has("x-agent-tracing")).toBe(true);
      expect(
        await transport
          .transport(async (_request, init) => {
            expect(new Headers(init?.headers).has("x-agent-tracing")).toBe(false);
            return new Response("independent");
          })("https://approved.example/agent")
          .then((response) => response.text()),
      ).toBe("independent");
      const spans = exporter.getFinishedSpans();
      const call = spans.find((span) => span.name === "execute_tool callee")!;
      expect(call.kind).toBe(2);
      const remoteTurn = spans.find((span) => span.name === "invoke_agent callee")!;
      expect(remoteTurn.parentSpanContext).toBeUndefined();
      expect(remoteTurn.links[0]?.context.spanId).toBe(call.spanContext().spanId);
      const rejection = new Error("original");
      let executions = 0;
      expect(() =>
        transport.receive(
          sent,
          () => false,
          () => {
            executions++;
            throw rejection;
          },
        ),
      ).toThrow(rejection);
      expect(executions).toBe(1);
      await transport.receive(
        new Headers({ "x-agent-tracing": "invalid" }),
        () => true,
        () =>
          callee.turn(
            {
              agentName: "callee",
              identity: { conversationId: "independent", runId: "independent", turnId: "turn" },
              sequence: 0,
            },
            async () => undefined,
          ),
      );
      expect(
        exporter
          .getFinishedSpans()
          .find((span) => span.attributes["agent.run.id"] === "independent")?.links,
      ).toHaveLength(0);
    } finally {
      await caller.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    }
  });
});

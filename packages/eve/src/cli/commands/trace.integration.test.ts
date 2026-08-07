import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listLocalTraces } from "#tracing/local-trace-reader.js";

import { resolveLocalTraces, runTraceListCommand, runTraceShowCommand } from "./trace.js";

const TRACE_ONE = "1".repeat(32);
const TRACE_TWO = "2".repeat(32);

describe("eve traces", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("lists traces newest first and skips malformed segments", async () => {
    const root = await createRoot();
    await writeSegment(
      root,
      TRACE_ONE,
      span("a", "agent.turn", 10, 20, undefined, {
        "agent.name": "weather",
        "agent.session.id": "session-one",
      }),
    );
    await writeSegment(
      root,
      TRACE_TWO,
      span("b", "agent.turn", 30, 40, undefined, {
        "agent.name": "research",
        "agent.session.id": "session-two",
      }),
    );
    await writeFile(
      join(root, ".eve", "traces", "v1", TRACE_TWO, "segments", `${"c".repeat(16)}.otlp.json`),
      "not json",
    );
    await writeSegment(root, TRACE_TWO, {
      ...span("d", "invalid-time", 1, 2),
      startTimeUnixNano: "18446744073709551616",
    });

    const traces = await listLocalTraces(root);

    expect(traces.map((trace) => trace.traceId)).toEqual([TRACE_TWO, TRACE_ONE]);
    expect(traces[0]).toMatchObject({ agentName: "research", sessionId: "session-two" });
  });

  it("resolves trace ids, session ids, and unambiguous prefixes", async () => {
    const root = await createRoot();
    await writeSegment(
      root,
      TRACE_ONE,
      span("a", "agent.turn", 10, 20, undefined, {
        "agent.session.id": "session-one",
      }),
    );
    await writeSegment(
      root,
      TRACE_TWO,
      span("b", "agent.turn", 20, 30, undefined, {
        "agent.session.id": "session-two",
      }),
    );
    const traces = await listLocalTraces(root);

    expect(ids(resolveLocalTraces(traces, TRACE_ONE))).toEqual([TRACE_ONE]);
    expect(ids(resolveLocalTraces(traces, "session-two"))).toEqual([TRACE_TWO]);
    expect(ids(resolveLocalTraces(traces, "session-o"))).toEqual([TRACE_ONE]);
    expect(() => resolveLocalTraces(traces, "session-")).toThrow(/matches 2 local traces/u);
    expect(() => resolveLocalTraces(traces, "missing")).toThrow(/No local trace matches/u);
  });

  it("resolves a windowed session to every window, oldest first", async () => {
    const root = await createRoot();
    await writeSegment(
      root,
      TRACE_TWO,
      span("b", "agent.session", 100, 100, undefined, {
        "agent.session.id": "session-one",
        "agent.session.window": 1,
      }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span("a", "agent.session", 10, 10, undefined, {
        "agent.session.id": "session-one",
        "agent.session.window": 0,
      }),
    );
    const traces = await listLocalTraces(root);

    expect(traces.map((trace) => trace.window)).toEqual([1, 0]);
    expect(ids(resolveLocalTraces(traces, "session-one"))).toEqual([TRACE_ONE, TRACE_TWO]);

    const output = collectingLogger();
    await runTraceShowCommand(output.logger, root, "session-one");

    expect(output.out[0]).toContain(TRACE_ONE);
    expect(output.out[0]).toContain(TRACE_TWO);
    expect(output.out[0]!.indexOf(TRACE_ONE)).toBeLessThan(output.out[0]!.indexOf(TRACE_TWO));
    expect(output.out[0]).toContain("Window");
  });

  it("resolves a subagent child to the parent window it recorded into", async () => {
    const root = await createRoot();
    const window = "a".repeat(16);
    const child = "b".repeat(16);
    await writeSegment(
      root,
      TRACE_ONE,
      span(window, "agent.session", 10, 10, undefined, {
        "agent.root.session.id": "session-one",
        "agent.session.id": "session-one",
        "agent.session.window": 0,
      }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span(child, "agent.turn", 20, 30, window, {
        "agent.root.session.id": "session-one",
        "agent.session.id": "child-one",
      }),
    );
    const traces = await listLocalTraces(root);

    // The opener still names the trace, so `eve trace ls` reads unchanged.
    expect(traces[0]!.sessionId).toBe("session-one");
    expect(ids(resolveLocalTraces(traces, "child-one"))).toEqual([TRACE_ONE]);
    expect(ids(resolveLocalTraces(traces, "session-one"))).toEqual([TRACE_ONE]);
  });

  it("renders a parented span tree and tolerates missing parents", async () => {
    const root = await createRoot();
    const turn = "a".repeat(16);
    const step = "b".repeat(16);
    const action = "c".repeat(16);
    await writeSegment(
      root,
      TRACE_ONE,
      span(turn, "agent.turn", 10, 100, undefined, {
        "agent.name": "weather",
        "agent.session.id": "session-one",
        "agent.turn.id": "turn-1",
      }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span(step, "agent.step", 20, 90, turn, {
        "agent.session.id": "session-one",
        "agent.step.attempt": 0,
        "agent.step.index": 0,
      }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span(action, "agent.action", 30, 80, step, {
        "agent.action.kind": "tool",
        "agent.action.name": "\u001B[31mweather\u001B[0m",
        "agent.session.id": "session-one",
      }),
    );
    await writeSegment(root, TRACE_ONE, {
      ...span("d", "[31mfailed[0m", 40, 50, "f".repeat(16)),
      status: { code: 2 },
    });
    const output = collectingLogger();

    await runTraceShowCommand(output.logger, root, "session-one");

    expect(output.out[0]).toContain("agent.turn [turn-1]");
    expect(output.out[0]).toContain("└─ agent.step [step 0, attempt 0]");
    expect(output.out[0]).toContain("└─ agent.action [tool: weather]");
    expect(output.out[0]).toContain("failed  10ms ERROR");
    expect(output.out[0]).not.toContain("\u001B");
  });

  it("shows subtree extent for a marker span instead of no duration", async () => {
    const root = await createRoot();
    const session = "a".repeat(16);
    const turn = "b".repeat(16);
    const step = "c".repeat(16);
    const orphanMarker = "d".repeat(16);
    await writeSegment(
      root,
      TRACE_ONE,
      span(session, "agent.session", 10, 10, undefined, {
        "agent.session.id": "session-one",
      }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span(turn, "agent.turn", 10, 95, session, { "agent.session.id": "session-one" }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span(step, "agent.step", 20, 90, turn, { "agent.session.id": "session-one" }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span(orphanMarker, "user.marker", 95, 95, turn, {
        "agent.session.id": "session-one",
      }),
    );
    const output = collectingLogger();

    await runTraceShowCommand(output.logger, root, "session-one");

    expect(output.out[0]).toContain("agent.session  85ms");
    expect(output.out[0]).toContain("agent.turn  85ms");
    expect(output.out[0]).toContain("agent.step  70ms");
    // A zero-duration span with no descendants has no extent to borrow.
    expect(output.out[0]).toContain("user.marker  0ms");
  });

  it("shows usage and cost chips on span rows and totals in the header", async () => {
    const root = await createRoot();
    await writeSegment(
      root,
      TRACE_ONE,
      span("a", "agent.step", 10, 80, undefined, {
        "agent.model.id": "gpt-5",
        "agent.session.id": "session-one",
        "agent.step.attempt": 0,
        "agent.step.index": 0,
        "agent.usage.input_tokens": 1400,
        "agent.usage.output_tokens": 213,
        "gen_ai.usage.gateway_cost": 0.0031,
      }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span("b", "ai.toolCall", 20, 30, "a", { "gen_ai.tool.name": "get_weather" }),
    );
    const output = collectingLogger();

    await runTraceShowCommand(output.logger, root, "session-one");

    expect(output.out[0]).toContain("Models");
    expect(output.out[0]).toContain("gpt-5");
    expect(output.out[0]).toContain("Tokens");
    expect(output.out[0]).toContain("↑1.4K in · ↓213 out");
    expect(output.out[0]).toContain("Cost");
    expect(output.out[0]).toContain("$0.0031");
    expect(output.out[0]).toContain("agent.step [step 0, attempt 0]  70ms  ↑1.4K ↓213 $0.0031");
    expect(output.out[0]).toContain("ai.toolCall  10ms  get_weather");
    // Attributes and events stay behind --verbose.
    expect(output.out[0]).not.toContain("events:");
    expect(output.out[0]).not.toContain("agent.model.id:");
  });

  it("expands every span with all attributes and events under --verbose", async () => {
    const root = await createRoot();
    await writeSegment(root, TRACE_ONE, {
      ...span("a", "agent.step", 10, 80, undefined, {
        "agent.model.id": "gpt-5",
        "agent.session.id": "session-one",
        "agent.step.index": 0,
      }),
      events: [
        { name: "step.started", timeUnixNano: "10000000" },
        {
          attributes: [{ key: "step.index", value: { intValue: 0 } }],
          name: "step.completed",
          timeUnixNano: "80000000",
        },
      ],
    });
    await writeSegment(root, TRACE_ONE, {
      ...span("b", "ai.toolCall", 20, 30, "a".repeat(16), {
        "gen_ai.tool.name": "get_weather",
      }),
      status: { code: 2, message: "tool exploded" },
    });
    const output = collectingLogger();

    await runTraceShowCommand(output.logger, root, "session-one", { verbose: true });

    expect(output.out[0]).toContain("agent.step [step 0]");
    expect(output.out[0]).toContain("├─ status: ok");
    expect(output.out[0]).toContain("├─ agent.model.id: gpt-5");
    expect(output.out[0]).toContain("├─ events:");
    expect(output.out[0]).toContain("├─ step.started  +0ms");
    expect(output.out[0]).toContain("└─ step.completed  +70ms");
    expect(output.out[0]).toContain("step.index: 0");
    expect(output.out[0]).toContain("└─ ai.toolCall  10ms  get_weather ERROR");
    expect(output.out[0]).toContain("├─ status: ERROR — tool exploded");
    expect(output.out[0]).toContain("└─ gen_ai.tool.name: get_weather");
    expect(output.out[0]).toContain("Errors");
    expect(output.out[0]).not.toContain("\u001B");
  });

  it("dumps full span data including attributes and events as JSON", async () => {
    const root = await createRoot();
    await writeSegment(root, TRACE_ONE, {
      ...span("a", "agent.step", 10, 80, undefined, {
        "agent.model.id": "gpt-5",
        "agent.session.id": "session-one",
      }),
      events: [{ name: "step.started", timeUnixNano: "10000000" }],
    });
    await writeSegment(root, TRACE_ONE, {
      ...span("b", "ai.toolCall", 20, 30, "a", { "gen_ai.tool.name": "get_weather" }),
      status: { code: 2, message: "tool exploded" },
    });
    const output = collectingLogger();

    await runTraceShowCommand(output.logger, root, "session-one", { json: true });

    const [trace] = JSON.parse(output.out[0]!) as [
      {
        traceId: string;
        spans: {
          attributes: Record<string, unknown>;
          events: { name: string; timeNs: string }[];
          name: string;
          statusMessage: string | null;
        }[];
      },
    ];
    expect(trace.traceId).toBe(TRACE_ONE);
    const stepSpan = trace.spans.find((span) => span.name === "agent.step")!;
    expect(stepSpan.attributes["agent.model.id"]).toBe("gpt-5");
    expect(stepSpan.events).toEqual([{ attributes: {}, name: "step.started", timeNs: "10000000" }]);
    const toolSpan = trace.spans.find((span) => span.name === "ai.toolCall")!;
    expect(toolSpan.statusMessage).toBe("tool exploded");
  });

  it("prints empty and JSON list output", async () => {
    const root = await createRoot();
    const empty = collectingLogger();
    await runTraceShowCommand(empty.logger, root);
    expect(empty.out).toEqual(["No local traces found under .eve/traces/v1."]);

    empty.out.length = 0;
    await runTraceListCommand(empty.logger, root);
    expect(empty.out).toEqual(["No local traces found under .eve/traces/v1."]);

    await writeSegment(
      root,
      TRACE_ONE,
      span("a", "agent.turn", 10, 20, undefined, {
        "agent.session.id": "session-one",
      }),
    );
    const latest = collectingLogger();
    await runTraceShowCommand(latest.logger, root);
    expect(latest.out[0]).toContain(TRACE_ONE);
    const json = collectingLogger();
    await runTraceListCommand(json.logger, root, { json: true });
    expect(JSON.parse(json.out[0]!)).toEqual([
      expect.objectContaining({ sessionId: "session-one", spanCount: 1, traceId: TRACE_ONE }),
    ]);
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "eve-trace-cmd-"));
    roots.push(root);
    return root;
  }
});

function ids(traces: readonly { readonly traceId: string }[]): string[] {
  return traces.map((trace) => trace.traceId);
}

function collectingLogger() {
  const out: string[] = [];
  return {
    out,
    logger: {
      error: (_message: string) => {},
      log: (message: string) => out.push(message),
    },
  };
}

interface TestSegmentSpan {
  readonly attributes: readonly { key: string; value: Record<string, unknown> }[];
  readonly endTimeUnixNano: string;
  readonly events?: readonly unknown[];
  readonly name: string;
  readonly parentSpanId?: string;
  readonly spanId: string;
  readonly startTimeUnixNano: string;
  readonly status: { readonly code: number; readonly message?: string };
  readonly traceId: string;
}

async function writeSegment(root: string, traceId: string, value: TestSegmentSpan): Promise<void> {
  const directory = join(root, ".eve", "traces", "v1", traceId, "segments");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${value.spanId}.otlp.json`),
    JSON.stringify({
      resourceSpans: [
        { scopeSpans: [{ scope: { name: "eve.agent" }, spans: [{ ...value, traceId }] }] },
      ],
    }),
  );
}

function span(
  id: string,
  name: string,
  start: number,
  end: number,
  parentSpanId?: string,
  attributes: Record<string, string | number> = {},
): TestSegmentSpan {
  return {
    attributes: Object.entries(attributes).map(([key, value]) => ({
      key,
      value: typeof value === "number" ? { intValue: value } : { stringValue: value },
    })),
    endTimeUnixNano: String(end * 1_000_000),
    name,
    parentSpanId,
    spanId: id.repeat(16).slice(0, 16),
    startTimeUnixNano: String(start * 1_000_000),
    status: { code: 0 },
    traceId: TRACE_ONE,
  };
}

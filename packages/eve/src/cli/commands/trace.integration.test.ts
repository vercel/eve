import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listLocalTraces } from "#harness/local-trace-reader.js";

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
    const terminal = "d".repeat(16);
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
      span(turn, "agent.turn", 10, 10, session, { "agent.session.id": "session-one" }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span(step, "agent.step", 20, 90, turn, { "agent.session.id": "session-one" }),
    );
    await writeSegment(
      root,
      TRACE_ONE,
      span(terminal, "agent.turn.terminal", 95, 95, turn, {
        "agent.session.id": "session-one",
      }),
    );
    const output = collectingLogger();

    await runTraceShowCommand(output.logger, root, "session-one");

    expect(output.out[0]).toContain("agent.session  85ms");
    expect(output.out[0]).toContain("agent.turn  85ms");
    expect(output.out[0]).toContain("agent.step  70ms");
    // A marker with no descendants has no extent to borrow.
    expect(output.out[0]).toContain("agent.turn.terminal  0ms");
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

async function writeSegment(
  root: string,
  traceId: string,
  value: ReturnType<typeof span>,
): Promise<void> {
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
) {
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

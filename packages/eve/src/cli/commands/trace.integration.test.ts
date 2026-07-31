import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listLocalTraces,
  resolveLocalTrace,
  runTraceListCommand,
  runTraceShowCommand,
} from "./trace.js";

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

    expect(resolveLocalTrace(traces, TRACE_ONE).traceId).toBe(TRACE_ONE);
    expect(resolveLocalTrace(traces, "session-two").traceId).toBe(TRACE_TWO);
    expect(resolveLocalTrace(traces, "session-o").traceId).toBe(TRACE_ONE);
    expect(() => resolveLocalTrace(traces, "session-")).toThrow(/matches 2 local traces/u);
    expect(() => resolveLocalTrace(traces, "missing")).toThrow(/No local trace matches/u);
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

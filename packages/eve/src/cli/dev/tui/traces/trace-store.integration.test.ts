import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTraceStore } from "./trace-store.js";

const TRACE_ONE = "1".repeat(32);
const TRACE_TWO = "2".repeat(32);

describe("trace store", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("lists no traces when the spool does not exist", async () => {
    const store = createTraceStore({ appRoot: await createRoot() });
    expect(await store.list()).toEqual([]);
  });

  it("lists traces newest-activity first and reads spans", async () => {
    const appRoot = await createRoot();
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: "a".repeat(16),
      name: "agent.turn",
      start: 100,
      end: 200,
    });
    await writeSegment(appRoot, TRACE_TWO, {
      spanId: "b".repeat(16),
      name: "agent.turn",
      start: 300,
      end: 400,
    });

    const store = createTraceStore({ appRoot });
    const entries = await store.list();
    expect(entries.map((entry) => entry.traceId).sort()).toEqual([TRACE_ONE, TRACE_TWO].sort());

    const trace = await store.read(TRACE_ONE);
    expect(trace?.spans).toHaveLength(1);
    expect(trace?.spans[0]?.name).toBe("agent.turn");
  });

  it("picks up spans appended between reads without re-parsing", async () => {
    const appRoot = await createRoot();
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: "a".repeat(16),
      name: "agent.turn",
      start: 100,
      end: 200,
    });
    const store = createTraceStore({ appRoot });
    expect((await store.read(TRACE_ONE))?.spans).toHaveLength(1);

    await writeSegment(appRoot, TRACE_ONE, {
      spanId: "b".repeat(16),
      name: "agent.step",
      start: 110,
      end: 150,
      parentSpanId: "a".repeat(16),
    });
    const grown = await store.read(TRACE_ONE);
    expect(grown?.spans).toHaveLength(2);
    expect(grown?.spans.map((span) => span.name)).toEqual(["agent.turn", "agent.step"]);
  });

  it("skips malformed segments without failing the trace", async () => {
    const appRoot = await createRoot();
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: "a".repeat(16),
      name: "agent.turn",
      start: 100,
      end: 200,
    });
    const directory = join(appRoot, ".eve", "traces", "v1", TRACE_ONE, "segments");
    await writeFile(join(directory, `${"c".repeat(16)}.otlp.json`), "not json{");

    const store = createTraceStore({ appRoot });
    expect((await store.read(TRACE_ONE))?.spans).toHaveLength(1);
  });

  it("forgets a trace when retention prunes it between reads", async () => {
    const appRoot = await createRoot();
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: "a".repeat(16),
      name: "agent.turn",
      start: 100,
      end: 200,
    });
    const store = createTraceStore({ appRoot });
    expect(await store.read(TRACE_ONE)).toBeDefined();

    await rm(join(appRoot, ".eve", "traces", "v1", TRACE_ONE), { recursive: true, force: true });
    expect(await store.read(TRACE_ONE)).toBeUndefined();
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "eve-trace-store-"));
    roots.push(root);
    return root;
  }
});

interface SegmentInput {
  readonly spanId: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly parentSpanId?: string;
}

async function writeSegment(appRoot: string, traceId: string, value: SegmentInput): Promise<void> {
  const directory = join(appRoot, ".eve", "traces", "v1", traceId, "segments");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${value.spanId}.otlp.json`),
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: "eve.agent" },
              spans: [
                {
                  attributes: [],
                  endTimeUnixNano: String(value.end * 1_000_000),
                  name: value.name,
                  parentSpanId: value.parentSpanId,
                  spanId: value.spanId,
                  startTimeUnixNano: String(value.start * 1_000_000),
                  status: { code: 0 },
                  traceId,
                },
              ],
            },
          ],
        },
      ],
    }),
  );
}

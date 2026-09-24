import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_OUTPUT_BYTES } from "#execution/sandbox/truncate-output.js";
import { getRun } from "#internal/workflow/runtime.js";
import { readLatestTaskReport, recordTaskReport } from "#subagents/task-reports.js";

vi.mock("#internal/workflow/runtime.js", () => ({ getRun: vi.fn() }));

const encoder = new TextEncoder();

/** An in-memory stand-in for one run's namespaced streams: one chunk per write. */
function fakeRun() {
  const streams = new Map<string, Uint8Array[]>();
  const chunksOf = (namespace: string | undefined) => {
    const key = namespace ?? "";
    const existing = streams.get(key);
    if (existing !== undefined) return existing;
    const created: Uint8Array[] = [];
    streams.set(key, created);
    return created;
  };
  return {
    streams,
    run: {
      getReadable(options: { namespace?: string; startIndex?: number }) {
        const chunks = chunksOf(options.namespace);
        let index = options.startIndex ?? 0;
        // The live stream never ends; a reader must stop at the tail it saw.
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) controller.enqueue(chunks[index++]!);
          },
        });
        return Object.assign(stream, { getTailIndex: async () => chunks.length - 1 });
      },
      getWritable(options: { namespace?: string; ops?: Promise<unknown>[] }) {
        const chunks = chunksOf(options.namespace);
        return new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk);
          },
        });
      },
    },
  };
}

const TOKEN = "eve:inbox:v1:eve:task-callback:owner";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("task reports", () => {
  it("keeps each call's latest answer in its own stream, apart from the event stream", async () => {
    const store = fakeRun();
    vi.mocked(getRun).mockReturnValue(store.run as never);

    const record = (report: Record<string, unknown> & { callId: string; answer: number }) =>
      recordTaskReport({ callbackToken: TOKEN, report, sessionId: "remote-1" });
    await record({ answer: 2, callId: "call-1", kind: "turn.completed", output: "Draft." });
    await record({ answer: 4, callId: "call-2", kind: "turn.completed", output: "Other." });
    await record({ answer: 6, callId: "call-1", kind: "turn.completed", output: "Pricing." });

    await expect(
      readLatestTaskReport({ callbackToken: TOKEN, callId: "call-1", sessionId: "remote-1" }),
    ).resolves.toEqual({ answer: 6, callId: "call-1", kind: "turn.completed", output: "Pricing." });
    expect(getRun).toHaveBeenCalledWith("remote-1");
    expect(store.streams.size).toBe(2);
    for (const namespace of store.streams.keys()) {
      expect(namespace).toMatch(/^eve\.task-reports\.[0-9a-f]{32}$/u);
    }
  });

  it("shows a report only to the holder of the callback token it was sent to", async () => {
    vi.mocked(getRun).mockReturnValue(fakeRun().run as never);
    await recordTaskReport({
      callbackToken: TOKEN,
      report: { answer: 2, callId: "call-1", kind: "turn.completed", output: "Refund approved." },
      sessionId: "remote-1",
    });

    await expect(
      readLatestTaskReport({
        callbackToken: "eve:inbox:v1:eve:task-callback:someone-else",
        callId: "call-1",
        sessionId: "remote-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("records an answer once when a retried callback step sends it again", async () => {
    const store = fakeRun();
    vi.mocked(getRun).mockReturnValue(store.run as never);
    const report = { answer: 2, callId: "call-1", kind: "turn.completed", output: "Done." };

    await recordTaskReport({ callbackToken: TOKEN, report, sessionId: "remote-1" });
    await recordTaskReport({ callbackToken: TOKEN, report, sessionId: "remote-1" });

    expect([...store.streams.values()].map((chunks) => chunks.length)).toEqual([1]);
  });

  it("keeps output past the result limit as the truncated text a model would read", async () => {
    vi.mocked(getRun).mockReturnValue(fakeRun().run as never);
    const output = "x".repeat(100).concat("\n").repeat(1_000);

    await recordTaskReport({
      callbackToken: TOKEN,
      report: { answer: 2, callId: "call-1", kind: "turn.completed", output },
      sessionId: "remote-1",
    });
    const stored = await readLatestTaskReport({
      callbackToken: TOKEN,
      callId: "call-1",
      sessionId: "remote-1",
    });

    expect(typeof stored?.output).toBe("string");
    expect(encoder.encode(stored?.output as string).byteLength).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES + 100,
    );
  });

  it("records nothing for a report that carries no answer, such as a cancelled call's", async () => {
    const store = fakeRun();
    vi.mocked(getRun).mockReturnValue(store.run as never);

    await recordTaskReport({
      callbackToken: TOKEN,
      report: { callId: "call-1", kind: "turn.failed" },
      sessionId: "remote-1",
    });

    expect(store.streams.size).toBe(0);
  });

  it("returns nothing for a call never answered, or whose latest record is unreadable", async () => {
    const store = fakeRun();
    vi.mocked(getRun).mockReturnValue(store.run as never);
    await recordTaskReport({
      callbackToken: TOKEN,
      report: { answer: 2, callId: "call-2", kind: "turn.completed", output: "Other." },
      sessionId: "remote-1",
    });
    const [chunks] = [...store.streams.values()];
    chunks!.push(encoder.encode("not json\n"));

    await expect(
      readLatestTaskReport({ callbackToken: TOKEN, callId: "call-1", sessionId: "remote-1" }),
    ).resolves.toBeUndefined();
    await expect(
      readLatestTaskReport({ callbackToken: TOKEN, callId: "call-2", sessionId: "remote-1" }),
    ).resolves.toBeUndefined();
  });
});

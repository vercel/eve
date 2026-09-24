import { beforeEach, describe, expect, it, vi } from "vitest";

import { getRun } from "#internal/workflow/runtime.js";
import { readLatestTaskReport, recordTaskReport } from "#subagents/task-reports.js";

vi.mock("#internal/workflow/runtime.js", () => ({ getRun: vi.fn() }));

const encoder = new TextEncoder();

/** An in-memory stand-in for one run's namespaced stream: one chunk per write. */
function fakeRun() {
  const chunks: Uint8Array[] = [];
  const namespaces: (string | undefined)[] = [];
  return {
    chunks,
    namespaces,
    run: {
      getReadable(options: { namespace?: string; startIndex?: number }) {
        namespaces.push(options.namespace);
        const start = options.startIndex ?? 0;
        let index = start;
        // The live stream never ends; a reader must stop at the tail it saw.
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) controller.enqueue(chunks[index++]!);
          },
        });
        return Object.assign(stream, { getTailIndex: async () => chunks.length - 1 });
      },
      getWritable(options: { namespace?: string; ops?: Promise<unknown>[] }) {
        namespaces.push(options.namespace);
        return new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk);
          },
        });
      },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("task reports", () => {
  it("returns the latest report a session recorded for one call, apart from its event stream", async () => {
    const store = fakeRun();
    vi.mocked(getRun).mockReturnValue(store.run as never);

    await recordTaskReport({
      report: { callId: "call-1", kind: "turn.completed", output: "Draft." },
      sessionId: "remote-1",
    });
    await recordTaskReport({
      report: { callId: "call-2", kind: "turn.completed", output: "Other." },
      sessionId: "remote-1",
    });
    await recordTaskReport({
      report: {
        callId: "call-1",
        kind: "turn.completed",
        output: "Draft with pricing.",
        steers: 1,
      },
      sessionId: "remote-1",
    });

    await expect(
      readLatestTaskReport({ callId: "call-1", sessionId: "remote-1" }),
    ).resolves.toEqual({
      callId: "call-1",
      kind: "turn.completed",
      output: "Draft with pricing.",
      steers: 1,
    });
    expect(getRun).toHaveBeenCalledWith("remote-1");
    expect(new Set(store.namespaces)).toEqual(new Set(["eve.task-reports"]));
  });

  it("returns nothing for a call the session never answered, and skips unreadable lines", async () => {
    const store = fakeRun();
    store.chunks.push(encoder.encode("not json\n"));
    vi.mocked(getRun).mockReturnValue(store.run as never);

    await expect(
      readLatestTaskReport({ callId: "call-1", sessionId: "remote-1" }),
    ).resolves.toBeUndefined();
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "#internal/logging.js";

import { createDevDiagnostics } from "./diagnostics.js";

const STUB_ENVIRONMENT = {
  eveVersion: "0.0.0-test",
  nodeVersion: process.version,
  platform: "test",
};

describe("createDevDiagnostics", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) =>
        rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
    );
    roots.length = 0;
  });

  async function makeRecorder() {
    const root = await mkdtemp(join(tmpdir(), "eve-diagnostics-recorder-"));
    roots.push(root);
    // Injected environment: the real collector spawns a `vercel --version`
    // child whose lingering handle makes Windows tmp-dir cleanup flaky.
    const diagnostics = await createDevDiagnostics(root, {
      environment: () => Promise.resolve(STUB_ENVIRONMENT),
    });
    return { root, diagnostics };
  }

  it("persists subscribed log records structured, once, and releases the console", async () => {
    const { root, diagnostics } = await makeRecorder();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const displayed: string[] = [];
    diagnostics.subscribeLogRecords((record) => displayed.push(record.message));

    try {
      createLogger("harness.tool-loop").error("tool execution failed", {
        toolName: "always_fail",
      });

      // Structured, exactly once: the record reaches the sink and the
      // display callback, never the console.
      expect(displayed).toEqual(["tool execution failed"]);
      expect(errorSpy).not.toHaveBeenCalled();

      diagnostics.unsubscribeLogRecords();
      createLogger("harness.tool-loop").error("after unsubscribe");
      expect(displayed).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith("[eve:harness.tool-loop] after unsubscribe");
    } finally {
      diagnostics.unsubscribeLogRecords();
      errorSpy.mockRestore();
    }

    await diagnostics.close();
    const log = await readFile(join(root, diagnostics.displayPath), "utf8");
    const records = log
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      expect.objectContaining({
        source: "log",
        level: "error",
        namespace: "harness.tool-loop",
        message: "tool execution failed",
        fields: { toolName: "always_fail" },
      }),
    ]);
  });

  it("accumulates session stats and reports them into the dump", async () => {
    const { root, diagnostics } = await makeRecorder();

    diagnostics.recordPrompt();
    diagnostics.recordStepUsage({ inputTokens: 100, outputTokens: 20 });
    diagnostics.recordStepUsage({ inputTokens: 40, outputTokens: 5 });
    diagnostics.recordStepUsage(undefined);
    diagnostics.recordToolCall("bash");
    diagnostics.recordToolCall("bash");
    diagnostics.recordToolCall("weather");
    diagnostics.recordSubagentDispatch("sub-1");
    diagnostics.recordSubagentDispatch("sub-1");
    diagnostics.reportStats();
    await diagnostics.close();

    const dumpPath = join(root, diagnostics.displayPath.replace(/\.log$/, ".dump"));
    const dump = JSON.parse(await readFile(dumpPath, "utf8")) as { session: unknown };
    expect(dump.session).toEqual({
      prompts: 1,
      inputTokens: 140,
      outputTokens: 25,
      toolCalls: { bash: 2, weather: 1 },
      subagents: 1,
    });
  });
});

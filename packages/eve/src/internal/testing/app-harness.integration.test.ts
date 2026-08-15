import { describe, expect, it } from "vitest";
import { start } from "#internal/workflow/runtime.js";

import { workflowEntry } from "#execution/workflow-entry.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";

function buildSerializedContext(overrides: {
  channelKind: string;
  continuationToken: string;
  mode: string;
}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: overrides.channelKind, state: {} },
    "eve.continuationToken": overrides.continuationToken,
    "eve.mode": overrides.mode,
  };
}

describe("AppHarness pilot", () => {
  it("runs a task-mode turn end-to-end against an in-memory test runtime", async () => {
    const runtime = createTestRuntime({ agent: { name: "pilot-agent" } });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "hello pilot harness" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "schedule:app-harness-pilot",
            mode: "task",
          }),
        },
      ]);

      const result = await run.returnValue;
      return result.output;
    });

    expect(typeof output).toBe("string");
    expect(output).toContain("hello pilot harness");
  });

  it("keeps compiled artifacts scoped to the test runtime session", async () => {
    const runtime = createTestRuntime({ agent: { name: "scope-probe" } });

    // Before `run`, the session has no artifacts installed.
    expect(runtime.session.compiledArtifacts).toBeNull();

    await runtime.run(async () => {
      // Inside `run`, reads hit the scoped session (installed on entry).
      expect(getActiveRuntimeSession()).toBe(runtime.session);
      expect(runtime.session.compiledArtifacts).not.toBeNull();
      expect(runtime.session.compiledArtifacts?.manifest.config.name).toBe("scope-probe");
    });

    // After `run`, the active session falls back to the process default, and
    // the process default never saw the test artifacts.
    const defaultSession = getActiveRuntimeSession();
    expect(defaultSession).not.toBe(runtime.session);
    expect(defaultSession.id).toBe("process-default");
    expect(defaultSession.compiledArtifacts).toBeNull();
  });

  it("isolates two concurrent test runtimes without cache crosstalk", async () => {
    const runtimeA = createTestRuntime({ agent: { name: "tenant-a" } });
    const runtimeB = createTestRuntime({ agent: { name: "tenant-b" } });

    const outputs = await Promise.all([
      runtimeA.run(async () => {
        const run = await start(workflowEntry, [
          {
            input: { message: "hello tenant-a" },
            serializedContext: buildSerializedContext({
              channelKind: "http",
              continuationToken: "schedule:app-harness-tenant-a",
              mode: "task",
            }),
          },
        ]);
        return (await run.returnValue).output;
      }),
      runtimeB.run(async () => {
        const run = await start(workflowEntry, [
          {
            input: { message: "hello tenant-b" },
            serializedContext: buildSerializedContext({
              channelKind: "http",
              continuationToken: "schedule:app-harness-tenant-b",
              mode: "task",
            }),
          },
        ]);
        return (await run.returnValue).output;
      }),
    ]);

    expect(outputs[0]).toContain("hello tenant-a");
    expect(outputs[1]).toContain("hello tenant-b");
    // Each runtime observed its own bundle cache; the shared process default
    // stayed clean because installation always targeted the scoped session.
    expect(runtimeA.session.bundleCache.size).toBeGreaterThan(0);
    expect(runtimeB.session.bundleCache.size).toBeGreaterThan(0);
  });
});

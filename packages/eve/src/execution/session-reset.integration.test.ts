import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { sessionDeliveryHookWorkflow } from "#internal/testing/session-delivery-hook-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";
import { defineSandboxAdapter } from "#shared/sandbox-value.js";

describe("session reset integration", () => {
  it("releases a parked continuation token and initializes a fresh sandbox", async () => {
    const continuationToken = "http:session-reset-immediate-reuse";
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource,
    });
    const sandboxes = createSessionSandboxHarness();
    const first = await start(sessionDeliveryHookWorkflow, [
      { nextToken: continuationToken, token: "http:session-reset-placeholder-1" },
    ]);

    try {
      await waitForHook(first, { token: continuationToken });
      await expect(sandboxes.open(first.runId)).resolves.toMatchObject({ id: "sandbox-1" });

      await expect(
        runtime.terminateSession({ reason: "User requested /new", sessionId: first.runId }),
      ).resolves.toEqual({ status: "terminated" });

      await expect(runtime.resolveSession(continuationToken)).resolves.toBeUndefined();
      await expect(getWorld().then((world) => world.runs.get(first.runId))).resolves.toMatchObject({
        status: "cancelled",
      });

      const second = await start(sessionDeliveryHookWorkflow, [
        { nextToken: continuationToken, token: "http:session-reset-placeholder-2" },
      ]);
      try {
        await expect(waitForHook(second, { token: continuationToken })).resolves.toMatchObject({
          runId: second.runId,
        });
        await expect(runtime.resolveSession(continuationToken)).resolves.toEqual({
          sessionId: second.runId,
        });
        await expect(sandboxes.open(second.runId)).resolves.toMatchObject({ id: "sandbox-2" });
        expect(sandboxes.initializedSessionIds).toEqual([first.runId, second.runId]);
      } finally {
        await second.cancel();
      }
    } finally {
      await first.cancel();
    }
  });
});

function createSessionSandboxHarness() {
  const initializedSessionIds: string[] = [];
  let sandboxCount = 0;
  const handles = new Map<string, ReturnType<typeof mockSandbox>>();
  interface Reference extends JsonObject {
    readonly id: string;
  }
  const adapt = defineSandboxAdapter<ReturnType<typeof mockSandbox>, Reference>({
    type: "eve/session-reset-test-sandbox",
    reference(sandbox) {
      return { id: sandbox.session.id };
    },
    restore({ id }) {
      const sandbox = handles.get(id);
      if (sandbox === undefined) throw new Error(`Missing sandbox "${id}".`);
      return sandbox;
    },
    session(sandbox) {
      return sandbox.session;
    },
  });
  const definition: ResolvedSandboxDefinition = {
    definition({ session }) {
      initializedSessionIds.push(session.id);
      sandboxCount += 1;
      const sandbox = mockSandbox({ id: `sandbox-${sandboxCount}` });
      handles.set(sandbox.session.id, sandbox);
      return adapt(sandbox);
    },
    logicalPath: "agent/sandbox/sandbox.ts",
    sourceHash: "session-reset-sandbox-source",
    sourceId: "agent/sandbox/sandbox",
    sourceKind: "module",
    templates: [],
  };
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition,
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };

  return {
    initializedSessionIds,
    async open(sessionId: string) {
      const access = await ensureSandboxAccess({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        context: new ContextContainer(),
        nodeId: "__root__",
        registry,
        session: {
          auth: { current: null, initiator: null },
          id: sessionId,
          turn: { id: "turn_0", sequence: 0 },
        },
        sessionId,
        state: null,
      });
      return await access.get();
    },
  };
}

import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { clearActiveSandboxHandlesForTest } from "#execution/sandbox/active-handles.js";
import { sessionDeliveryHookWorkflow } from "#internal/testing/session-delivery-hook-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

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
        expect(sandboxes.sessionKeys).toHaveLength(2);
        expect(sandboxes.sessionKeys[0]).not.toBe(sandboxes.sessionKeys[1]);
      } finally {
        await second.cancel();
      }
    } finally {
      await first.cancel();
      clearActiveSandboxHandlesForTest();
    }
  });
});

function createSessionSandboxHarness() {
  const initializedSessionIds: string[] = [];
  const sessionKeys: string[] = [];
  let sandboxCount = 0;
  const backend: SandboxBackend = {
    async create(input) {
      sessionKeys.push(input.sessionKey);
      sandboxCount += 1;
      const sandbox = mockSandbox({ id: `sandbox-${sandboxCount}` });
      return {
        captureState: async () => ({
          backendName: "session-reset-test",
          metadata: {},
          sessionKey: input.sessionKey,
        }),
        session: sandbox.session,
        shutdown: async () => {},
        useSessionFn: async () => sandbox.session,
      };
    },
    name: "session-reset-test",
    prewarm: async () => ({ reused: false }),
  };
  const definition: ResolvedSandboxDefinition = {
    backend,
    logicalPath: "agent/sandbox/sandbox.ts",
    onSession({ ctx }) {
      initializedSessionIds.push(ctx.session.id);
    },
    sourceId: "agent/sandbox/sandbox",
    sourceKind: "module",
  };
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition,
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };

  return {
    initializedSessionIds,
    sessionKeys,
    async open(sessionId: string) {
      const context = new ContextContainer();
      context.set(SessionKey, {
        auth: { current: null, initiator: null },
        sessionId,
        turn: { id: "turn_0", sequence: 0 },
      });
      const access = await ensureSandboxAccess({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        nodeId: "__root__",
        registry,
        runOnSession: async (callback) => await contextStorage.run(context, callback),
        sessionId,
        state: null,
      });
      return await access.get();
    },
  };
}

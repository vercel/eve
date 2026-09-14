import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { clearActiveSandboxHandlesForTest } from "#execution/sandbox/active-handles.js";
import { sessionCommandInboxWorkflow } from "#internal/testing/session-command-inbox-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { start } from "#internal/workflow/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { defineSandbox } from "#public/definitions/sandbox.js";

describe("session reset integration", () => {
  it("releases a parked continuation token and initializes a fresh sandbox", async () => {
    const continuationToken = "http:session-reset-immediate-reuse";
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource,
    });
    const sandboxes = createSessionSandboxHarness();
    const first = await start(sessionCommandInboxWorkflow, [{ token: continuationToken }]);

    try {
      await waitForHook(first, { token: continuationToken });
      await expect(sandboxes.open(first.runId)).resolves.toMatchObject({ id: "sandbox-1" });

      await expect(
        runtime.dispatchContinuation({
          command: { kind: "reset", reason: "User requested /new" },
          continuationToken,
        }),
      ).resolves.toEqual({ previousSessionId: first.runId, status: "reset" });

      await expect(first.returnValue).resolves.toEqual([]);
      await expect(runtime.resolveContinuation(continuationToken)).resolves.toBeUndefined();

      const second = await start(sessionCommandInboxWorkflow, [{ token: continuationToken }]);
      try {
        await expect(waitForHook(second, { token: continuationToken })).resolves.toMatchObject({
          runId: second.runId,
        });
        await expect(runtime.resolveContinuation(continuationToken)).resolves.toEqual({
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
      const status = await first.status;
      if (status === "pending" || status === "running") await first.cancel();
      clearActiveSandboxHandlesForTest();
    }
  });
});

function createSessionSandboxHarness() {
  const initializedSessionIds: string[] = [];
  const sessionKeys: string[] = [];
  let sandboxCount = 0;
  const provider = defineSandboxProvider({
    name: "session-reset-test",
    environment: () => ({
      async getOrCreate(context) {
        sessionKeys.push(context.sandboxName);
        sandboxCount += 1;
        const sandbox = mockSandbox({ id: `sandbox-${sandboxCount}` });
        return context.handle({
          delete: async () => {},
          metadata: {},
          sandbox: sandbox.session,
          shutdown: async () => {},
          stop: async () => {},
        });
      },
      prepare: async () => ({ artifact: {}, reused: false }),
    }),
  });
  const environment = provider.environment();
  const definition: ResolvedSandboxDefinition = {
    environment,
    kind: "independent",
    logicalPath: "agent/sandbox/sandbox.ts",
    selector: defineSandbox(({ session }) => {
      initializedSessionIds.push(session.id);
      return environment.create();
    }),
    sourceHash: "session-reset-sandbox-v1",
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
        sessionId,
        state: null,
      });
      return await access.get();
    },
  };
}

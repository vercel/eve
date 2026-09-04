import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { clearActiveSandboxHandlesForTest } from "#execution/sandbox/active-handles.js";
import { startTestSession } from "#internal/testing/session.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

describe("session reset integration", () => {
  it("releases a parked continuation token and initializes a fresh sandbox", async () => {
    const continuationToken = "http:session-reset-immediate-reuse";
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const sandboxes = createSessionSandboxHarness();
    const app = await createTestRuntime({
      modules: [
        {
          logicalPath: "sandbox.ts",
          loadNamespace: async () => ({
            default: defineSandbox({
              backend: sandboxes.definition.backend,
              onSession: sandboxes.definition.onSession,
            }),
          }),
        },
      ],
    });
    await app.run(async () => {
      const seed = {
        input: { message: "hello" },
        serializedContext: {
          "eve.auth": null,
          "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
          "eve.channel": { kind: "http", state: {} },
          "eve.continuationToken": continuationToken,
          "eve.mode": "conversation",
        },
      };
      const first = await startTestSession(seed);
      const firstEvents = captureTurnEvents(first);
      try {
        await firstEvents.nextTurn();
        await expect(sandboxes.open(first.sessionId)).resolves.toMatchObject({ id: "sandbox-1" });
        await expect(
          runtime.dispatchContinuation({
            command: { kind: "reset", reason: "User requested /new" },
            continuationToken,
          }),
        ).resolves.toEqual({ previousSessionId: first.sessionId, status: "reset" });
        await expect(runtime.resolveContinuation(continuationToken)).resolves.toBeUndefined();

        const second = await startTestSession(seed);
        const secondEvents = captureTurnEvents(second);
        try {
          await secondEvents.nextTurn();
          await expect(runtime.resolveContinuation(continuationToken)).resolves.toEqual({
            sessionId: second.sessionId,
          });
          await expect(sandboxes.open(second.sessionId)).resolves.toMatchObject({
            id: "sandbox-2",
          });
          expect(sandboxes.initializedSessionIds).toEqual([first.sessionId, second.sessionId]);
          expect(sandboxes.sessionKeys).toHaveLength(2);
          expect(sandboxes.sessionKeys[0]).not.toBe(sandboxes.sessionKeys[1]);
        } finally {
          secondEvents.dispose();
          await second.cancel();
        }
      } finally {
        firstEvents.dispose();
        clearActiveSandboxHandlesForTest();
      }
    });
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
        delete: async () => {},
        session: sandbox.session,
        stop: async () => {},
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
    definition,
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

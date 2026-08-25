import { mockSandbox, type MockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
} from "#public/definitions/sandbox-backend.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/**
 * A {@link SandboxBackend} that serves the given {@link MockSandbox} session
 * instead of provisioning a real VM/container. Suitable for patching a
 * resolved runtime bundle's sandbox registry in integration tests.
 */
export function mockSandboxBackend(sandbox: MockSandbox): SandboxBackend {
  return {
    create: async (input: SandboxBackendCreateInput) => ({
      captureState: async () => ({
        backendName: "test",
        metadata: {},
        sessionKey: input.sessionKey,
      }),
      session: sandbox.session,
      shutdown: async () => {},
      stop: async () => {},
      useSessionFn: async () => sandbox.session,
    }),
    name: "test",
    prewarm: async () => ({ reused: false }),
  };
}

/**
 * Replaces the compiled bundle's sandbox backend with an in-memory mock.
 *
 * The test harness compiles the framework-default sandbox, whose backend is
 * selected from the host environment. Flows that open the sandbox through
 * the real pipeline (e.g. self-delegation, which shares the parent sandbox
 * and opens it eagerly at dispatch) would otherwise provision a real
 * VM/container. Must be called inside `runtime.run(...)` so the patch lands
 * on the scoped session's cached bundle.
 */
export async function installMockSandboxBackend(id?: string): Promise<MockSandbox> {
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });
  const sandbox = mockSandbox(id === undefined ? {} : { id });
  (bundle.graph.root.sandboxRegistry.sandbox.definition as { backend: SandboxBackend }).backend =
    mockSandboxBackend(sandbox);
  return sandbox;
}

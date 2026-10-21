import { afterEach, describe, expect, it, vi } from "vitest";

import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { VercelSandbox } from "#public/sandbox/vercel.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => null),
}));

interface AcmeSandboxSession extends SandboxSession {
  exists(path: string): Promise<boolean>;
}

class AcmeSession {
  readonly #present = "present.txt";

  async exists(path: string): Promise<boolean> {
    return path === this.#present;
  }
}

function acmeProvider() {
  const openHandle = async () => ({
    sandbox: Object.assign(new AcmeSession(), mockSandbox().session),
    onRuntimeShutdown: async () => {},
    onSandboxDelete: async () => {},
    onSandboxStop: async () => {},
  });
  const start = vi.fn(async () => ({ handle: await openHandle(), state: null }));
  const resume = vi.fn(openHandle);
  const environment = defineSandboxProvider<undefined, undefined, null, null, AcmeSandboxSession>({
    name: "acme",
    environment: () => ({ onSessionEnd: async () => {}, prepare: async () => null, resume, start }),
  }).environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        selector: defineSandbox(async () => await environment.open()),
        revisionHash: "hash",
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return { environment, registry, resume, start };
}

afterEach(() => shutdownActiveSandboxHandles());

describe("buildBaseToolContext – getSandbox abort binding", () => {
  it("returns a session bound to the turn abort signal", async () => {
    let observed: AbortSignal | undefined;
    const sandbox = mockSandbox({
      run: (options) => {
        observed = options.abortSignal;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const runtime = await createTestRuntime();
    const controller = new AbortController();

    await runtime.runAsSession({ sandbox }, async () => {
      const ctx = buildBaseToolContext({
        options: { abortSignal: controller.signal, toolCallId: "call_1" },
        toolName: "shell",
      });
      expect(ctx.toolName).toBe("shell");
      const live = await ctx.getSandbox();
      await live.run({ command: "echo ready" });
    });

    expect(observed).toBeDefined();
    expect(observed).not.toBe(controller.signal);
    expect(observed?.aborted).toBe(false);
    controller.abort(new Error("turn cancelled"));
    expect(observed?.aborted).toBe(true);
  });

  it("forwards the configured environment", async () => {
    const environment = VercelSandbox.environment();
    const sandbox = mockSandbox({ name: "eve-sbx-vercel-test" });
    const runtime = await createTestRuntime();

    await runtime.runAsSession({ sandboxAccess: { ...sandbox.access, environment } }, async () => {
      const ctx = buildBaseToolContext({
        options: { toolCallId: "call_1" },
        toolName: "shell",
      });
      const live = await ctx.getSandbox(environment);
      expect(live.name).toBe("eve-sbx-vercel-test");
    });
  });

  it.each([
    { opened: "start", state: null },
    {
      opened: "resume",
      state: { session: { providerName: "acme", state: null, stateProtocolVersion: 1 } },
    },
  ] as const)(
    "keeps class methods of a custom provider session opened by $opened",
    async ({ opened, state }) => {
      const provider = acmeProvider();
      const sandboxAccess = await ensureSandboxAccess({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        nodeId: "__root__",
        registry: provider.registry,
        sessionId: "session_test",
        state,
      });
      const runtime = await createTestRuntime();

      await runtime.runAsSession({ sandboxAccess }, async () => {
        const ctx = buildBaseToolContext({
          options: { toolCallId: "call_1" },
          toolName: "check",
        });
        const live = await ctx.getSandbox(provider.environment);
        expect(live).toBeInstanceOf(AcmeSession);
        await expect(live.exists("present.txt")).resolves.toBe(true);
      });
      expect(provider[opened]).toHaveBeenCalledOnce();
    },
  );

  it("binds the inert fallback signal when no turn signal exists", async () => {
    let observed: AbortSignal | undefined;
    const sandbox = mockSandbox({
      run: (options) => {
        observed = options.abortSignal;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const runtime = await createTestRuntime();

    await runtime.runAsSession({ sandbox }, async () => {
      const ctx = buildBaseToolContext({
        options: { toolCallId: "call_1" },
        toolName: "shell",
      });
      const live = await ctx.getSandbox();
      await live.run({ command: "echo ready" });
    });

    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(false);
  });
});

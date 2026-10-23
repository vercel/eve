import { describe, expect, it } from "vitest";

import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { VercelSandbox } from "#public/sandbox/vercel.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

interface AcmeSandboxSession extends SandboxSession {
  exists(path: string): Promise<boolean>;
}

class AcmeSession {
  async exists(path: string): Promise<boolean> {
    return path === "present.txt";
  }
}

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

  it.fails("keeps custom provider session methods defined on a class", async () => {
    const environment = defineSandboxProvider<undefined, undefined, null, null, AcmeSandboxSession>(
      {
        name: "acme",
        environment: () => ({
          prepare: async () => null,
          resume: async () => {
            throw new Error("unused");
          },
          start: async () => {
            throw new Error("unused");
          },
        }),
      },
    ).environment();
    const sandbox = mockSandbox();
    const providerSession: AcmeSandboxSession = Object.assign(new AcmeSession(), sandbox.session);
    const runtime = await createTestRuntime();

    await runtime.runAsSession(
      { sandboxAccess: { ...sandbox.access, environment, get: async () => providerSession } },
      async () => {
        const ctx = buildBaseToolContext({
          options: { toolCallId: "call_1" },
          toolName: "check",
        });
        const live = await ctx.getSandbox(environment);
        await expect(live.exists("present.txt")).resolves.toBe(true);
      },
    );
  });

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

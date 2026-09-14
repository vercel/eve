import { describe, expect, it, vi } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import { createSandboxProviderResources, defineSandboxProvider } from "#shared/sandbox-provider.js";

describe("defineSandboxProvider", () => {
  it("gives providers separate workspace and skill trees at their expected paths", async () => {
    const preparation = vi.fn(async () => {});
    const getOrCreate = vi.fn(async (ctx) => {
      const sandbox = mockSandbox().session;
      return ctx.handle({
        delete: async () => {},
        metadata: { remoteId: "remote-1" },
        sandbox,
        shutdown: async () => {},
        stop: async () => {},
      });
    });
    const provider = defineSandboxProvider<
      { readonly image?: string },
      undefined,
      { readonly remoteId: string }
    >({
      name: "test-provider",
      environment: () => ({
        getOrCreate,
        async prepare(ctx) {
          expect(ctx.resources.workspace).toMatchObject({
            mountPath: "/eve/resources/workspace",
            path: "/tmp/resources/workspace",
            targetPath: "/workspace",
          });
          expect(ctx.resources.workspace?.files[0]?.relativePath).toBe("notes.txt");
          expect(ctx.resources.skills).toMatchObject({
            mountPath: "/eve/resources/skills",
            path: "/tmp/resources/skills",
            targetPath: "$HOME/.agents/skills",
          });
          expect(ctx.resources.skills?.files[0]?.relativePath).toBe("review/SKILL.md");
          await ctx.runPreparation(mockSandbox().session);
          return { artifact: {}, reused: false };
        },
      }),
    });

    const environment = provider.environment({ prepare: preparation });
    const runtime = getSandboxEnvironmentRuntime(environment);
    const resources = createSandboxProviderResources({
      resourcesKey: "resources-v1",
      resourcesPath: "/tmp/resources",
      seedFiles: [
        { content: "notes", path: "/workspace/notes.txt" },
        { content: "skill", path: "$HOME/.agents/skills/review/SKILL.md" },
      ],
    });
    await runtime.implementation.prepare({
      appRoot: "/tmp/app",
      resources,
      runPreparation: async (sandbox) => await runtime.prepare?.(sandbox),
      templateName: "template-v1",
    });
    expect(preparation).toHaveBeenCalledOnce();

    await runtime.implementation.getOrCreate(
      {
        appRoot: "/tmp/app",
        handle: (providerHandle) => providerHandle,
        options: undefined,
        resources,
        sandboxName: "session-1",
      },
      { artifact: {}, templateName: "template-v1" },
    );
    expect(getOrCreate).toHaveBeenCalledOnce();
  });
});

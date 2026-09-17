import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

const provider = defineSandboxProvider<
  { readonly image?: string },
  { readonly networkPolicy?: "allow-all" | "deny-all" },
  { readonly templateId: string },
  { readonly nativeId: string; readonly version: 1 }
>({
  name: "test-provider",
  environment: (environmentOptions) => ({
    async prepare() {
      return { templateId: environmentOptions?.image ?? "default" };
    },
    async resume(_context, _artifact, state) {
      return handle(state.nativeId);
    },
    async start(context) {
      const nativeId = `native-${context.session.id}`;
      return { handle: handle(nativeId), state: { nativeId, version: 1 } };
    },
  }),
});

function handle(nativeId: string) {
  return {
    sandbox: {
      resolvePath: (path: string) => path,
      run: vi.fn(),
      spawn: vi.fn(),
      readFile: vi.fn(),
      readBinaryFile: vi.fn(),
      readTextFile: vi.fn(),
      writeFile: vi.fn(),
      writeBinaryFile: vi.fn(),
      writeTextFile: vi.fn(),
      removePath: vi.fn(),
    },
    onRuntimeShutdown: vi.fn(async () => {}),
    onSessionDelete: vi.fn(async () => {}),
    onSessionStop: vi.fn(async () => {}),
    nativeId,
  };
}

describe("defineSandboxProvider", () => {
  it("preserves provider-owned environment and open option types", () => {
    const environment = provider.environment({ image: "node:24" });
    expect(environment.provider).toBe("test-provider");
    expectTypeOf(environment.open).parameter(0).toEqualTypeOf<
      | {
          readonly networkPolicy?: "allow-all" | "deny-all";
        }
      | undefined
    >();
  });

  it("stores one direct implementation without extracting provider options", async () => {
    const environment = provider.environment({ image: "node:24" });
    const implementation = getSandboxEnvironmentRuntime(environment).implementation;
    const artifact = await implementation.prepare({
      files: { list: async () => [], read: async () => new Uint8Array(), readText: async () => "" },
      host: {
        loadOptionalPackage: async ({ importModule }) => await importModule(),
        resolveProjectPath: (path) => path,
      },
      resources: { source: { kind: "none" } },
      storagePath: "/tmp/test",
    });
    expect(artifact).toEqual({ templateId: "node:24" });
  });
});

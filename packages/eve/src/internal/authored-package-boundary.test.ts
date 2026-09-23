import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvePackageDependencyPath } from "#internal/application/package.js";
import {
  createGenerationPackageBoundaryPlugin,
  createRuntimeLoaderPackageBoundaryPlugin,
  type RolldownResolveContext,
} from "#internal/authored-package-boundary.js";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe("createGenerationPackageBoundaryPlugin", () => {
  it("keeps eve imports portable", async () => {
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: PACKAGE_ROOT,
    });
    const resolveId = plugin.resolveId as (
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;
    const context: RolldownResolveContext = {
      async resolve() {
        throw new Error("framework imports should resolve before delegating");
      },
    };

    await expect(
      resolveId.call(context, "eve/tools", join(PACKAGE_ROOT, "agent/tools/probe.ts"), {
        kind: "import-statement",
      }),
    ).resolves.toEqual({ external: true, id: "eve/tools" });
    await expect(
      resolveId.call(
        context,
        "eve/self-modification",
        join(PACKAGE_ROOT, "agent/extensions/edit.ts"),
        {
          kind: "import-statement",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves package-private imports from the importing dependency", async () => {
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: join(PACKAGE_ROOT, "test/consumer-app"),
    });
    const resolveId = plugin.resolveId as (
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;
    const context: RolldownResolveContext = {
      async resolve() {
        throw new Error("package imports should resolve before delegating");
      },
    };

    await expect(
      resolveId.call(
        context,
        "#shared/git.js",
        join(PACKAGE_ROOT, "dist/src/self-modification/agent.js"),
        { kind: "import-statement" },
      ),
    ).resolves.toEqual({
      id: join(PACKAGE_ROOT, "dist/src/shared/git.js"),
    });
  });

  it.each(["@ai-sdk/harness-codex", "@ai-sdk/harness-codex/internal"])(
    "keeps AI SDK harness adapter import %s external",
    async (source) => {
      const plugin = createGenerationPackageBoundaryPlugin({
        externalDependencies: [],
        packageRoot: PACKAGE_ROOT,
      });
      const resolveId = plugin.resolveId as (
        this: RolldownResolveContext,
        source: string,
        importer: string | undefined,
        options: { kind: string },
      ) => Promise<unknown>;
      const context: RolldownResolveContext = {
        async resolve() {
          return { id: join(PACKAGE_ROOT, "node_modules", source) };
        },
      };

      await expect(
        resolveId.call(context, source, join(PACKAGE_ROOT, "agent/agent.ts"), {
          kind: "import-statement",
        }),
      ).resolves.toEqual({ external: true, id: source });
    },
  );

  it.each(["@ai-sdk/harness", "@ai-sdk/provider-utils", "@acme/harness-codex"])(
    "does not automatically externalize %s",
    async (source) => {
      const plugin = createGenerationPackageBoundaryPlugin({
        externalDependencies: [],
        packageRoot: PACKAGE_ROOT,
      });
      const resolveId = plugin.resolveId as (
        this: RolldownResolveContext,
        source: string,
        importer: string | undefined,
        options: { kind: string },
      ) => Promise<unknown>;
      const context: RolldownResolveContext = {
        async resolve() {
          throw new Error("unmatched package imports should remain bundled");
        },
      };

      await expect(
        resolveId.call(context, source, join(PACKAGE_ROOT, "agent/agent.ts"), {
          kind: "import-statement",
        }),
      ).resolves.toBeUndefined();
    },
  );
});

describe("createRuntimeLoaderPackageBoundaryPlugin", () => {
  it("binds eve imports to the executing framework installation", async () => {
    const plugin = createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: PACKAGE_ROOT,
    });
    const resolveId = plugin.resolveId as (
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;
    const context: RolldownResolveContext = {
      async resolve() {
        throw new Error("framework imports should resolve before delegating");
      },
    };

    await expect(
      resolveId.call(
        context,
        "eve/tools",
        join(
          PACKAGE_ROOT,
          "dist/src/self-modification/extension/subagents/agent/tools/edit_file.js",
        ),
        { kind: "import-statement" },
      ),
    ).resolves.toEqual({
      external: true,
      id: resolvePackageDependencyPath("eve/tools"),
    });
  });

  it("resolves eve package imports through the published dist mapping", async () => {
    const plugin = createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: PACKAGE_ROOT,
    });
    const resolveId = plugin.resolveId as (
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;
    const context: RolldownResolveContext = {
      async resolve() {
        throw new Error("package imports should resolve before delegating");
      },
    };

    await expect(
      resolveId.call(
        context,
        "#shared/git.js",
        join(PACKAGE_ROOT, "dist/src/self-modification/agent.js"),
        { kind: "import-statement" },
      ),
    ).resolves.toEqual({
      id: join(PACKAGE_ROOT, "dist/src/shared/git.js"),
    });
  });

  it("resolves AI SDK harness adapters without explicit configuration", async () => {
    const plugin = createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: "/workspace/app",
    });
    const resolveId = plugin.resolveId as (
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;
    const resolvedId = "/workspace/app/node_modules/@ai-sdk/harness-codex/dist/index.js";
    const context: RolldownResolveContext = {
      async resolve() {
        return { id: resolvedId };
      },
    };

    await expect(
      resolveId.call(
        context,
        "@ai-sdk/harness-codex",
        "/workspace/packages/agent-config/index.ts",
        { kind: "import-statement" },
      ),
    ).resolves.toEqual({ external: true, id: resolvedId });
  });

  it.each([
    [
      "C:\\workspace\\app\\node_modules\\external-only\\index.js",
      "file:///C:/workspace/app/node_modules/external-only/index.js",
    ],
    [
      "\\\\server\\share\\app\\node_modules\\external-only\\index.js",
      "file://server/share/app/node_modules/external-only/index.js",
    ],
    [
      "/workspace/app/node_modules/external-only/index.js",
      "/workspace/app/node_modules/external-only/index.js",
    ],
    ["external-only", "external-only"],
  ])("emits resolved external %s as %s", async (resolvedId, expectedId) => {
    const plugin = createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: ["external-only"],
      packageRoot: "C:\\workspace\\app",
    });
    const resolveId = plugin.resolveId as (
      this: RolldownResolveContext,
      source: string,
      importer: string | undefined,
      options: { kind: string },
    ) => Promise<unknown>;
    const context: RolldownResolveContext = {
      async resolve() {
        return { id: resolvedId };
      },
    };

    await expect(
      resolveId.call(context, "external-only", "C:\\workspace\\app\\agent\\tools\\ping.ts", {
        kind: "import-statement",
      }),
    ).resolves.toEqual({
      external: true,
      id: expectedId,
    });
  });
});

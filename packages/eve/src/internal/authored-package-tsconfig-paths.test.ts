import { realpathSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", () => fsMocks);

type ResolveIdHook = {
  readonly filter: {
    readonly id: {
      readonly exclude: RegExp;
    };
  };
  handler(
    this: {
      resolve(
        source: string,
        importer: string | undefined,
        options: { kind: string; skipSelf: boolean },
      ): Promise<{ readonly id: string } | null>;
    },
    source: string,
    importer: string | undefined,
    options: { kind: string },
  ): Promise<{ readonly id: string } | undefined>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authored package tsconfig paths resolver", () => {
  it("filters path and protocol imports before the resolver hook runs", () => {
    const hook = getResolveIdHook();

    for (const source of [
      ".hidden",
      "./local",
      "../parent",
      "/absolute",
      "C:\\absolute",
      "node:fs",
      "data:text/plain,hi",
      "file:///x",
    ]) {
      expect(hook.filter.id.exclude.test(source), source).toBe(true);
    }

    for (const source of ["zod", "@scope/package", "#package-import"]) {
      expect(hook.filter.id.exclude.test(source), source).toBe(false);
    }
  });

  it("reuses stat probes within one plugin and refreshes them for the next", async () => {
    const packageRoot = "/workspace/issue-848/package";
    const importer = `${packageRoot}/src/entry.ts`;
    const typescriptTarget = `${packageRoot}/src/value.ts`;
    const tsxTarget = `${packageRoot}/src/value.tsx`;
    const files = new Set([`${packageRoot}/package.json`, typescriptTarget]);
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@package/*": ["src/*"],
          },
        },
      }),
    );
    fsMocks.stat.mockImplementation(async (path) => {
      if (files.has(String(path))) {
        return { isFile: () => true };
      }

      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    const context = {
      resolve: vi.fn(async () => null),
    };
    const firstHook = getResolveIdHook();

    await expect(
      firstHook.handler.call(context, "@package/value", importer, {
        kind: "import-statement",
      }),
    ).resolves.toEqual({ id: typescriptTarget });
    expect(fsMocks.stat).toHaveBeenCalledTimes(4);

    files.delete(typescriptTarget);
    files.add(tsxTarget);

    await expect(
      firstHook.handler.call(context, "@package/value", importer, {
        kind: "import-statement",
      }),
    ).resolves.toEqual({ id: typescriptTarget });
    expect(fsMocks.stat).toHaveBeenCalledTimes(4);

    const nextHook = getResolveIdHook();
    await expect(
      nextHook.handler.call(context, "@package/value", importer, {
        kind: "import-statement",
      }),
    ).resolves.toEqual({ id: tsxTarget });
    expect(fsMocks.stat).toHaveBeenCalledTimes(7);
  });

  it("skips eve's own modules, and no other package's, when a build bundles dependencies", async () => {
    const evePackageRoot = realpathSync.native(resolvePackageRoot());
    const siblingPackageRoot = `${evePackageRoot}-sibling`;
    const nestedPackageRoot = join(evePackageRoot, "node_modules", "dependency");
    const files = new Set(
      [evePackageRoot, siblingPackageRoot, nestedPackageRoot].flatMap((packageRoot) => [
        join(packageRoot, "package.json"),
        join(packageRoot, "src", "value.ts"),
      ]),
    );
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({ compilerOptions: { paths: { "@package/*": ["src/*"] } } }),
    );
    fsMocks.stat.mockImplementation(async (path) => {
      if (files.has(String(path))) {
        return { isFile: () => true };
      }

      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    const context = {
      resolve: vi.fn(async () => null),
    };
    const hook = getResolveIdHook({
      authoredSourceOnly: true,
      // Host-bundled, so only the check for eve's modules could turn the nested dependency away.
      handlesInstalledModule: () => true,
    });
    const resolveFrom = (packageRoot: string) =>
      hook.handler.call(context, "@package/value", join(packageRoot, "src", "entry.ts"), {
        kind: "import-statement",
      });

    await expect(resolveFrom(evePackageRoot)).resolves.toBeUndefined();
    await expect(resolveFrom(siblingPackageRoot)).resolves.toEqual({
      id: join(siblingPackageRoot, "src", "value.ts"),
    });
    await expect(resolveFrom(nestedPackageRoot)).resolves.toEqual({
      id: join(nestedPackageRoot, "src", "value.ts"),
    });
  });
});

function getResolveIdHook(
  input: { authoredSourceOnly?: boolean; handlesInstalledModule?: (path: string) => boolean } = {},
): ResolveIdHook {
  const plugin = createAuthoredPackageTsConfigPathsPlugin({
    appPackageRoot: "/app",
    extensions: [".ts", ".tsx"],
    ...input,
  });
  return plugin.resolveId as ResolveIdHook;
}

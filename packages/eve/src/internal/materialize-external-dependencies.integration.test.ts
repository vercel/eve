import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { CompiledExternalDependencyPlan } from "#compiler/external-dependency-plan.js";
import {
  createCompiledExternalDependencyPlan,
  resolveCompiledExternalDependencyImport,
  verifyCompiledExternalDependencyPlanFiles,
} from "#compiler/external-dependency-plan.js";
import {
  EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT,
  materializeCompiledExternalDependencyPlan,
} from "#internal/materialize-external-dependencies.js";

describe("external dependency materialization", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("atomically publishes a complete dependency link graph under concurrent publishers", async () => {
    const fixture = await createExternalDependencyFixture(cleanupRoots);
    const cacheRoot = join(fixture.root, "cache");
    const cacheAlias = join(fixture.root, "cache-alias");
    await mkdir(cacheRoot);
    await symlink(cacheRoot, cacheAlias, "junction");

    const [direct, aliased] = await Promise.all([
      materializeCompiledExternalDependencyPlan({
        destinationRoot: cacheRoot,
        plan: fixture.plan,
      }),
      materializeCompiledExternalDependencyPlan({
        destinationRoot: cacheAlias,
        plan: fixture.plan,
      }),
    ]);

    const entry = fixture.plan.entries[0]!;
    expect(await readdir(cacheRoot)).toEqual([EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT]);
    for (const materialized of [direct, aliased]) {
      const resolution = resolveCompiledExternalDependencyImport(
        materialized.plan,
        "fixture-runtime",
      )!;
      const namespace = (await import(pathToFileURL(resolution.resolvedPath).href)) as {
        value: string;
      };
      expect(namespace.value).toBe("helper:scoped");
    }

    const rootPackage = entry.packages.find((pkg) => pkg.id === entry.rootPackageId)!;
    const rootPackagePath = join(
      cacheRoot,
      EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT,
      entry.semanticSha256,
      rootPackage.id,
    );
    const helperMount = join(rootPackagePath, "node_modules", "fixture-helper");
    const scopedMount = join(rootPackagePath, "node_modules", "@fixture", "scoped-helper");
    expect((await lstat(helperMount)).isSymbolicLink()).toBe(true);
    expect((await lstat(scopedMount)).isSymbolicLink()).toBe(true);
    await expect(realpath(helperMount)).resolves.toBe(
      await materializedPackageRoot(cacheRoot, entry, "fixture-helper"),
    );
    await expect(realpath(scopedMount)).resolves.toBe(
      await materializedPackageRoot(cacheRoot, entry, "@fixture/scoped-helper"),
    );
  });

  it("publishes into the current layout without trusting an older immutable cache", async () => {
    const fixture = await createExternalDependencyFixture(cleanupRoots);
    const cacheRoot = join(fixture.root, "cache");
    const entry = fixture.plan.entries[0]!;
    const staleRoot = join(cacheRoot, entry.semanticSha256);
    await mkdir(staleRoot, { recursive: true });
    await writeFile(join(staleRoot, "stale"), "prior-layout");

    const materialized = await materializeCompiledExternalDependencyPlan({
      destinationRoot: cacheRoot,
      plan: fixture.plan,
    });
    const rootPackage = materialized.plan.entries[0]!.packages.find(
      (pkg) => pkg.id === materialized.plan.entries[0]!.rootPackageId,
    )!;

    expect(rootPackage.resolvedPackageRoot).toContain(
      join(cacheRoot, EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT, entry.semanticSha256),
    );
    await expect(readFile(join(staleRoot, "stale"), "utf8")).resolves.toBe("prior-layout");
  });

  it("rejects a corrupted cache hit without rewriting the published tree", async () => {
    const fixture = await createExternalDependencyFixture(cleanupRoots);
    const cacheRoot = join(fixture.root, "cache");
    await materializeCompiledExternalDependencyPlan({
      destinationRoot: cacheRoot,
      plan: fixture.plan,
    });

    const entry = fixture.plan.entries[0]!;
    const rootPackagePath = await materializedPackageRoot(cacheRoot, entry, "fixture-runtime");
    const helperMount = join(rootPackagePath, "node_modules", "fixture-helper");
    await unlink(helperMount);
    await symlink(rootPackagePath, helperMount, "junction");
    const corruptedLinkText = await readlink(helperMount);
    const corruptedLinkStats = await lstat(helperMount);

    await expect(
      materializeCompiledExternalDependencyPlan({
        destinationRoot: cacheRoot,
        plan: fixture.plan,
      }),
    ).rejects.toThrow("points to an unexpected package");
    expect(await readlink(helperMount)).toBe(corruptedLinkText);
    expect((await lstat(helperMount)).ino).toBe(corruptedLinkStats.ino);
    await expect(realpath(helperMount)).resolves.toBe(rootPackagePath);
  });

  it("relocates a shared transitive package within each authenticated entry", async () => {
    const fixture = await createSharedTransitiveFixture(cleanupRoots);
    const cacheRoot = join(fixture.root, "cache");
    const materialized = await materializeCompiledExternalDependencyPlan({
      destinationRoot: cacheRoot,
      plan: fixture.plan,
    });
    const [alpha, beta] = materialized.plan.entries;
    expect(alpha?.id).toBe("fixture-alpha");
    expect(beta?.id).toBe("fixture-beta");

    const alphaShared = alpha!.packages.find((pkg) => pkg.packageName === "fixture-shared")!;
    const betaShared = beta!.packages.find((pkg) => pkg.packageName === "fixture-shared")!;
    const expectedAlphaSharedRoot = join(
      cacheRoot,
      EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT,
      alpha!.semanticSha256,
      alphaShared.id,
    );
    const expectedBetaSharedRoot = join(
      cacheRoot,
      EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT,
      beta!.semanticSha256,
      betaShared.id,
    );
    expect(alphaShared.resolvedPackageRoot).toBe(expectedAlphaSharedRoot);
    expect(betaShared.resolvedPackageRoot).toBe(expectedBetaSharedRoot);
    expect(betaShared.resolvedPackageRoot).not.toBe(alphaShared.resolvedPackageRoot);

    const alphaRoot = alpha!.packages.find((pkg) => pkg.id === alpha!.rootPackageId)!;
    const betaRoot = beta!.packages.find((pkg) => pkg.id === beta!.rootPackageId)!;
    const canonicalAlphaSharedRoot = await realpath(expectedAlphaSharedRoot);
    const canonicalBetaSharedRoot = await realpath(expectedBetaSharedRoot);
    await expect(
      realpath(join(alphaRoot.resolvedPackageRoot, "node_modules", "shared-alias")),
    ).resolves.toBe(canonicalAlphaSharedRoot);
    await expect(
      realpath(join(betaRoot.resolvedPackageRoot, "node_modules", "shared-alias")),
    ).resolves.toBe(canonicalBetaSharedRoot);

    await writeFile(join(expectedBetaSharedRoot, "index.js"), 'export const shared = "changed";\n');
    await expect(verifyCompiledExternalDependencyPlanFiles(materialized.plan)).rejects.toThrow(
      'external dependency "fixture-beta" package "fixture-shared" changed after compilation',
    );
  });

  it("rejects traversal names before creating materialization paths", async () => {
    const fixture = await createExternalDependencyFixture(cleanupRoots);
    const mutations: Array<{
      readonly apply: (plan: CompiledExternalDependencyPlan) => void;
      readonly name: string;
    }> = [
      {
        apply(plan) {
          Reflect.set(plan.entries[0]!, "id", "../../escaped-entry");
          Reflect.set(plan.entries[0]!, "packageName", "../../escaped-entry");
        },
        name: "entry",
      },
      {
        apply(plan) {
          Reflect.set(plan.entries[0]!.packages[0]!, "packageName", "../../escaped-package");
        },
        name: "package record",
      },
      {
        apply(plan) {
          Reflect.set(
            plan.entries[0]!.packages[0]!.dependencies[0]!,
            "packageName",
            "../../../../escaped-mount",
          );
        },
        name: "dependency mount",
      },
    ];

    for (const mutation of mutations) {
      const plan = structuredClone(fixture.plan);
      mutation.apply(plan);
      const destinationRoot = join(fixture.root, `capture-${mutation.name.replaceAll(" ", "-")}`);
      await expect(
        materializeCompiledExternalDependencyPlan({
          destinationRoot,
          plan,
        }),
      ).rejects.toThrow("Invalid external dependency package name");
      await expect(access(destinationRoot)).rejects.toThrow();
      await expect(access(join(fixture.root, "escaped-mount"))).rejects.toThrow();
    }
  });
});

async function createExternalDependencyFixture(cleanupRoots: string[]): Promise<{
  readonly plan: Awaited<ReturnType<typeof createCompiledExternalDependencyPlan>>;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "eve-external-materialization-"));
  cleanupRoots.push(root);
  const appRoot = join(root, "app");
  await Promise.all([
    writePackage(appRoot, {
      name: "fixture-app",
      source: "",
    }),
    writePackage(join(appRoot, "node_modules", "fixture-runtime"), {
      dependencies: {
        "@fixture/scoped-helper": "1.0.0",
        "fixture-helper": "1.0.0",
      },
      name: "fixture-runtime",
      source:
        'import { helper } from "fixture-helper";\nimport { scoped } from "@fixture/scoped-helper";\nexport const value = `${helper}:${scoped}`;\n',
    }),
    writePackage(join(appRoot, "node_modules", "fixture-helper"), {
      name: "fixture-helper",
      source: 'export const helper = "helper";\n',
    }),
    writePackage(join(appRoot, "node_modules", "@fixture", "scoped-helper"), {
      name: "@fixture/scoped-helper",
      source: 'export const scoped = "scoped";\n',
    }),
  ]);
  const plan = await createCompiledExternalDependencyPlan([
    {
      packageName: "fixture-runtime",
      scope: { kind: "application", nodeId: "__root__", sourceRoot: appRoot },
    },
  ]);
  return { plan, root };
}

async function createSharedTransitiveFixture(cleanupRoots: string[]): Promise<{
  readonly plan: Awaited<ReturnType<typeof createCompiledExternalDependencyPlan>>;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "eve-shared-external-materialization-"));
  cleanupRoots.push(root);
  const appRoot = join(root, "app");
  await Promise.all([
    writePackage(appRoot, {
      name: "fixture-app",
      source: "",
    }),
    writePackage(join(appRoot, "node_modules", "fixture-alpha"), {
      dependencies: { "shared-alias": "npm:fixture-shared@1.0.0" },
      name: "fixture-alpha",
      source: 'export { shared } from "shared-alias";\n',
    }),
    writePackage(join(appRoot, "node_modules", "fixture-beta"), {
      dependencies: { "shared-alias": "npm:fixture-shared@1.0.0" },
      name: "fixture-beta",
      source: 'export { shared } from "shared-alias";\n',
    }),
    writePackage(join(appRoot, "node_modules", "shared-alias"), {
      name: "fixture-shared",
      source: 'export const shared = "shared";\n',
    }),
  ]);
  const plan = await createCompiledExternalDependencyPlan([
    {
      packageName: "fixture-alpha",
      scope: { kind: "application", nodeId: "alpha", sourceRoot: appRoot },
    },
    {
      packageName: "fixture-beta",
      scope: { kind: "application", nodeId: "beta", sourceRoot: appRoot },
    },
  ]);
  return { plan, root };
}

async function writePackage(
  packageRoot: string,
  input: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly name: string;
    readonly source: string;
  },
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeFile(join(packageRoot, "index.js"), input.source),
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        dependencies: input.dependencies,
        exports: "./index.js",
        name: input.name,
        type: "module",
      }),
    ),
  ]);
}

async function materializedPackageRoot(
  cacheRoot: string,
  entry: Awaited<ReturnType<typeof createCompiledExternalDependencyPlan>>["entries"][number],
  packageName: string,
): Promise<string> {
  const pkg = entry.packages.find((candidate) => candidate.packageName === packageName)!;
  return await realpath(
    join(cacheRoot, EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT, entry.semanticSha256, pkg.id),
  );
}

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertCompiledWorkflowWorldPlanIntegrity,
  compileWorkflowWorldPlan,
  compiledWorkflowWorldPlanSchema,
} from "#compiler/workflow-world-plan.js";
import { materializeCompiledWorkflowWorldPlan } from "#compiler/workflow-world-plan-materialization.js";
import { resolveExpectedWorkflowVersion } from "#internal/application/package.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { force: true, recursive: true })),
  );
  delete (globalThis as Record<string, unknown>).__workflowWorldPlanEvaluated;
});

describe("compileWorkflowWorldPlan", () => {
  it("records the effective closed native target", async () => {
    await expect(
      compileWorkflowWorldPlan({
        appRoot: "/does/not/need/to/exist",
        selection: "host-default",
        target: "vercel",
      }),
    ).resolves.toEqual({ kind: "native", selection: "host-default", target: "vercel" });

    await expect(
      compileWorkflowWorldPlan({
        appRoot: "/does/not/need/to/exist",
        selection: "configured",
        target: "@workflow/world-local",
      }),
    ).resolves.toEqual({ kind: "native", selection: "configured", target: "local" });
  });

  it("rejects path-like custom targets before resolution", async () => {
    await expect(
      compileWorkflowWorldPlan({
        appRoot: "/app",
        selection: "configured",
        target: "./world.js",
      }),
    ).rejects.toThrow("Relative paths, absolute paths, URLs, and package subpaths");
  });

  it("binds a custom package and its transitive package graph without evaluation", async () => {
    const fixture = await createWorldFixture();
    const plan = await compileWorkflowWorldPlan({
      appRoot: fixture.appRoot,
      selection: "configured",
      target: "@acme/eve-world",
    });

    expect((globalThis as Record<string, unknown>).__workflowWorldPlanEvaluated).toBeUndefined();
    expect(plan).toMatchObject({
      kind: "host-module",
      packageName: "@acme/eve-world",
      selection: "configured",
      backing: {
        entryPackageId: "root",
        entryPath: fixture.worldEntryPath,
        packages: [
          expect.objectContaining({ id: "root", name: "@acme/eve-world" }),
          expect.objectContaining({ id: "root>@workflow/core", name: "@workflow/core" }),
          expect.objectContaining({
            id: "root>fixture-world-dependency",
            name: "fixture-world-dependency",
          }),
          expect.objectContaining({
            id: "root>fixture-world-dependency>fixture-types-only",
            name: "fixture-types-only",
          }),
        ],
      },
    });
    await expect(assertCompiledWorkflowWorldPlanIntegrity(plan)).resolves.toBeUndefined();
  });

  it("changes identity when the same package specifier changes content", async () => {
    const fixture = await createWorldFixture();
    const first = await compileWorkflowWorldPlan({
      appRoot: fixture.appRoot,
      selection: "configured",
      target: "@acme/eve-world",
    });
    await writeFile(fixture.worldEntryPath, 'export const marker = "two";\n');
    const second = await compileWorkflowWorldPlan({
      appRoot: fixture.appRoot,
      selection: "configured",
      target: "@acme/eve-world",
    });

    expect(first.kind).toBe("host-module");
    expect(second.kind).toBe("host-module");
    if (first.kind !== "host-module" || second.kind !== "host-module") return;
    expect(second.packageName).toBe(first.packageName);
    expect(second.backing.identitySha256).not.toBe(first.backing.identitySha256);
  });

  it("rejects source and serialized graph tampering before load", async () => {
    const fixture = await createWorldFixture();
    const plan = await compileWorkflowWorldPlan({
      appRoot: fixture.appRoot,
      selection: "configured",
      target: "@acme/eve-world",
    });
    if (plan.kind !== "host-module") throw new Error("Expected a host-module plan.");

    const tamperedArtifact = {
      ...plan,
      backing: { ...plan.backing, identitySha256: "f".repeat(64) },
    };
    expect(compiledWorkflowWorldPlanSchema.safeParse(tamperedArtifact).success).toBe(false);

    await writeFile(fixture.worldEntryPath, 'export const marker = "tampered";\n');
    await expect(assertCompiledWorkflowWorldPlanIntegrity(plan)).rejects.toThrow(
      "changed after compilation",
    );
    expect((globalThis as Record<string, unknown>).__workflowWorldPlanEvaluated).toBeUndefined();
  });

  it("materializes an immutable graph that no longer depends on authored installation paths", async () => {
    const fixture = await createWorldFixture();
    const plan = await compileWorkflowWorldPlan({
      appRoot: fixture.appRoot,
      selection: "configured",
      target: "@acme/eve-world",
    });
    const materialized = await materializeCompiledWorkflowWorldPlan({
      destinationRoot: join(fixture.appRoot, ".eve", "bound-world"),
      plan,
    });
    if (plan.kind !== "host-module" || materialized.kind !== "host-module") {
      throw new Error("Expected host-module plans.");
    }

    expect(materialized.backing.identitySha256).toBe(plan.backing.identitySha256);
    expect(materialized.backing.mode).toBe("materialized");
    expect(materialized.backing.entryPath).not.toBe(plan.backing.entryPath);
    expect(
      materialized.backing.packages.map((selectedPackage) => selectedPackage.sourceRootPath),
    ).toEqual(plan.backing.packages.map((selectedPackage) => selectedPackage.rootPath));
    await expect(
      materializeCompiledWorkflowWorldPlan({
        destinationRoot: join(fixture.appRoot, ".eve", "bound-world"),
        plan,
      }),
    ).resolves.toEqual(materialized);
    await writeFile(fixture.worldEntryPath, 'export const marker = "changed after copy";\n');
    await expect(assertCompiledWorkflowWorldPlanIntegrity(plan)).rejects.toThrow(
      "changed after compilation",
    );
    await expect(assertCompiledWorkflowWorldPlanIntegrity(materialized)).resolves.toBeUndefined();
    expect((globalThis as Record<string, unknown>).__workflowWorldPlanEvaluated).toBeUndefined();

    const entryPackage = materialized.backing.packages.find(
      (selectedPackage) => selectedPackage.id === materialized.backing.entryPackageId,
    );
    if (entryPackage === undefined) throw new Error("Expected a materialized entry package.");
    expect(existsSync(join(entryPackage.rootPath, "tsconfig.json"))).toBe(false);
    const dependencyMount = join(entryPackage.rootPath, "node_modules", "fixture-world-dependency");
    await rm(dependencyMount, { force: true, recursive: true });
    await symlink(entryPackage.rootPath, dependencyMount, "junction");
    await expect(assertCompiledWorkflowWorldPlanIntegrity(materialized)).rejects.toThrow(
      "no longer points to compiled backing",
    );
  });

  it("fails compilation for an incompatible custom Workflow protocol line", async () => {
    const fixture = await createWorldFixture({ workflowCoreVersion: "^4.0.0" });
    await expect(
      compileWorkflowWorldPlan({
        appRoot: fixture.appRoot,
        selection: "configured",
        target: "@acme/eve-world",
      }),
    ).rejects.toThrow(/@workflow\/core 4\.x/);
  });

  it("fails compilation when a required transitive package is not physically backed", async () => {
    const fixture = await createWorldFixture({ missingRequiredDependency: true });
    await expect(
      compileWorkflowWorldPlan({
        appRoot: fixture.appRoot,
        selection: "configured",
        target: "@acme/eve-world",
      }),
    ).rejects.toThrow('requires dependency "missing-world-dependency"');
  });
});

async function createWorldFixture(
  options: {
    readonly missingRequiredDependency?: boolean;
    readonly workflowCoreVersion?: string;
  } = {},
): Promise<{ readonly appRoot: string; readonly worldEntryPath: string }> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-workflow-world-plan-"));
  temporaryDirectories.push(appRoot);
  const worldRoot = join(appRoot, "node_modules", "@acme", "eve-world");
  const workflowCoreRoot = join(appRoot, "node_modules", "@workflow", "core");
  const dependencyRoot = join(appRoot, "node_modules", "fixture-world-dependency");
  const typesOnlyDependencyRoot = join(appRoot, "node_modules", "fixture-types-only");
  const worldEntryPath = join(worldRoot, "index.js");
  await Promise.all([
    mkdir(worldRoot, { recursive: true }),
    mkdir(workflowCoreRoot, { recursive: true }),
    mkdir(dependencyRoot, { recursive: true }),
    mkdir(typesOnlyDependencyRoot, { recursive: true }),
    writeFile(
      join(appRoot, "package.json"),
      '{"name":"workflow-world-plan-app","type":"module"}\n',
    ),
  ]);
  await writeFile(
    join(worldRoot, "package.json"),
    `${JSON.stringify({
      dependencies: {
        "fixture-world-dependency": "1.0.0",
        ...(options.missingRequiredDependency === true
          ? { "missing-world-dependency": "1.0.0" }
          : {}),
      },
      exports: "./index.js",
      name: "@acme/eve-world",
      type: "module",
      version: "1.0.0",
      peerDependencies: {
        "@workflow/core":
          options.workflowCoreVersion ?? resolveExpectedWorkflowVersion() ?? "5.0.0-beta.43",
      },
    })}\n`,
  );
  await writeFile(
    worldEntryPath,
    [
      'import "fixture-world-dependency";',
      "globalThis.__workflowWorldPlanEvaluated = true;",
      'throw new Error("custom World code must not execute during compilation");',
      "export const marker = 1;",
      "",
    ].join("\n"),
  );
  await writeFile(join(worldRoot, "tsconfig.json"), '{"extends":"missing-build-only-config"}\n');
  await writeFile(
    join(dependencyRoot, "package.json"),
    '{"dependencies":{"fixture-types-only":"1.0.0"},"exports":"./index.js","name":"fixture-world-dependency","type":"module","version":"1.0.0"}\n',
  );
  await writeFile(
    join(typesOnlyDependencyRoot, "package.json"),
    '{"name":"fixture-types-only","types":"./index.d.ts","version":"1.0.0"}\n',
  );
  await writeFile(
    join(workflowCoreRoot, "package.json"),
    `${JSON.stringify({
      exports: "./index.js",
      name: "@workflow/core",
      type: "module",
      version: resolveExpectedWorkflowVersion() ?? "5.0.0-beta.43",
    })}\n`,
  );
  await writeFile(join(dependencyRoot, "index.js"), 'export const dependency = "bound";\n');
  await writeFile(join(typesOnlyDependencyRoot, "index.d.ts"), "export {};\n");
  await writeFile(join(workflowCoreRoot, "index.js"), "export const protocol = true;\n");
  return { appRoot, worldEntryPath: await realpath(worldEntryPath) };
}

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

interface ReportMetricDelta {
  baseline: number;
  current: number;
  delta: number;
}

interface BundledDependencyFixture {
  name: string;
  size: number;
}

interface NitroBundleReport {
  appLabel: string;
  comparison?: {
    app: {
      functionAliasCount: ReportMetricDelta;
      functions: Array<{
        changed: boolean;
        internalRoutesAdded: string[];
        publicRoutesAdded: string[];
        relativePath: string;
        status: "added" | "changed" | "removed" | "unchanged";
        totalBytes: ReportMetricDelta;
      }>;
      internalRouteCount: ReportMetricDelta;
      publicRouteCount: ReportMetricDelta;
      staticAssetBytes: ReportMetricDelta;
      uniqueFunctionBytes: ReportMetricDelta;
      uniqueFunctionCount: ReportMetricDelta;
    };
    baselineLabel: string;
    package: null | {
      installedDependencyBytes: ReportMetricDelta;
      installedSizeBytes: ReportMetricDelta;
      packedSizeBytes: ReportMetricDelta;
      peerDependenciesAdded: string[];
      peerDependenciesChanged: Array<{
        baseline: string;
        current: string;
        name: string;
      }>;
      peerDependenciesRemoved: string[];
      runtimeDependenciesAdded: string[];
      runtimeDependenciesChanged: Array<{
        baseline: string;
        current: string;
        name: string;
      }>;
      runtimeDependenciesRemoved: string[];
      unpackedSizeBytes: ReportMetricDelta;
    };
    sizeBudget: {
      checks: Array<{
        area: string;
        dependency?: string;
        failed: boolean;
        kind: string;
        metric: string;
        summary: string;
      }>;
      failed: boolean;
      thresholdRatio: number;
    };
  };
  functionAliasCount: number;
  functions: Array<{
    internalRoutes: string[];
    publicRoutes: string[];
    relativePath: string;
    topTracedPackages: Array<{
      bytes: number;
      name: string;
    }>;
    totalBytes: number;
    vcConfig: Record<string, unknown>;
  }>;
  internalRouteCount: number;
  publishedPackage: null | {
    installedDependencyBytes: number;
    installedFileCount: number;
    installedPackageBytes: number;
    installedSizeBytes: number;
    packageLabel: string;
    packageName: string;
    packedSizeBytes: number;
    peerDependencies: Array<{
      name: string;
      optional: boolean;
      range: string;
    }>;
    publishedFileCount: number;
    runtimeDependencies: Array<{
      name: string;
      range: string;
    }>;
    topInstalledPackages: Array<{
      bytes: number;
      name: string;
    }>;
    topPublishedFiles: Array<{
      bytes: number;
      path: string;
    }>;
    unpackedSizeBytes: number;
    version: string;
  };
  publicRouteCount: number;
  sizeBudgetAcknowledged?: boolean;
  staticAssetBytes: number;
  uniqueFunctionBytes: number;
  uniqueFunctionCount: number;
}

interface NitroBundleReportModule {
  collectNitroBundleReport(input: {
    appLabel: string;
    appRoot: string;
    packageLabel?: string;
    packageRoot?: string;
  }): Promise<NitroBundleReport>;
  compareNitroBundleReports(
    report: NitroBundleReport,
    baselineReport: NitroBundleReport,
    options?: {
      baselineLabel?: string;
    },
  ): NitroBundleReport["comparison"];
  renderNitroBundleReportMarkdown(report: NitroBundleReport): string;
}

interface ReportFixtureOptions {
  additionalFunctionBytes?: number;
  bundledDependencies?: BundledDependencyFixture[];
  packageIndexBytes?: number;
  packageRuntimeBytes?: number;
  serverEntryBytes?: number;
  staticAssetBytes?: number;
}

async function loadBundleReportModule(): Promise<NitroBundleReportModule> {
  const moduleUrl = new URL("../../../../scripts/nitro-bundle-report.mjs", import.meta.url);

  return (await import(moduleUrl.href)) as NitroBundleReportModule;
}

async function writeSizedFile(path: string, size: number): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, `${"x".repeat(Math.max(0, size - 1))}\n`, "utf8");
}

async function writeBundledDependency(
  packageRoot: string,
  dependency: BundledDependencyFixture,
): Promise<void> {
  const dependencyRoot = join(packageRoot, "node_modules", ...dependency.name.split("/"));
  await mkdir(dependencyRoot, {
    recursive: true,
  });
  await writeFile(
    join(dependencyRoot, "package.json"),
    `${JSON.stringify(
      {
        name: dependency.name,
        version: "1.0.0",
        main: "index.js",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeSizedFile(join(dependencyRoot, "index.js"), dependency.size);
}

function formatReportBytes(bytes: number): string {
  if (bytes < 1_000) {
    return `${bytes} B`;
  }

  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(1)} kB`;
  }

  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatReportSizeDelta(bytes: number): string {
  const emoji = bytes > 0 ? "⚠️" : bytes < 0 ? "✅" : "➖";

  if (bytes === 0) {
    return `0 B ${emoji}`;
  }

  return `${bytes > 0 ? "+" : "-"}${formatReportBytes(Math.abs(bytes))} ${emoji}`;
}

async function createReportFixture(
  options: ReportFixtureOptions = {},
): Promise<{ appRoot: string; packageRoot: string }> {
  const appRoot = await createScratchDirectory("eve-nitro-bundle-report-");
  const outputRoot = join(appRoot, ".vercel", "output");
  const functionsRoot = join(outputRoot, "functions");
  const packageRoot = join(appRoot, "packages", "eve-publish-fixture");
  const serverFunctionRoot = join(functionsRoot, "__server.func");

  await mkdir(join(serverFunctionRoot, "_libs"), {
    recursive: true,
  });
  await mkdir(join(serverFunctionRoot, "node_modules", "@scope", "pkg"), {
    recursive: true,
  });
  await mkdir(join(serverFunctionRoot, "node_modules", "rolldown"), {
    recursive: true,
  });
  await mkdir(join(outputRoot, "static"), {
    recursive: true,
  });
  await mkdir(join(functionsRoot, "api"), {
    recursive: true,
  });

  await writeFile(
    join(serverFunctionRoot, ".vc-config.json"),
    `${JSON.stringify(
      {
        handler: "index.mjs",
        launcherType: "Nodejs",
        runtime: "nodejs24.x",
        shouldAddHelpers: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(outputRoot, "nitro.json"),
    `${JSON.stringify(
      {
        date: "2026-04-15T18:45:11.837Z",
        framework: {
          name: "nitro",
          version: "3.0.260311-beta",
        },
        preset: "vercel",
        serverEntry: "functions/__server.func/index.mjs",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(outputRoot, "config.json"),
    `${JSON.stringify(
      {
        routes: [
          { src: "/", dest: "/index" },
          { src: "/(.*)", dest: "/__server" },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeSizedFile(join(serverFunctionRoot, "index.mjs"), options.serverEntryBytes ?? 1_500);
  await writeSizedFile(join(serverFunctionRoot, "_runtime.mjs"), 500);
  await writeSizedFile(join(serverFunctionRoot, "_libs", "@workflow+core.mjs"), 750);
  await writeSizedFile(join(serverFunctionRoot, "_libs", "jose.mjs"), 250);
  await writeSizedFile(
    join(serverFunctionRoot, "node_modules", "@scope", "pkg", "index.js"),
    1_000,
  );
  await writeSizedFile(join(serverFunctionRoot, "node_modules", "rolldown", "bin.js"), 2_000);
  await writeSizedFile(join(outputRoot, "static", "index.html"), options.staticAssetBytes ?? 300);

  await symlink("./__server.func", join(functionsRoot, "index.func"));
  await symlink("./../__server.func", join(functionsRoot, "api", "runs.func"));

  if (options.additionalFunctionBytes !== undefined) {
    const adminFunctionRoot = join(functionsRoot, "admin.func");

    await mkdir(adminFunctionRoot, {
      recursive: true,
    });
    await writeFile(
      join(adminFunctionRoot, ".vc-config.json"),
      `${JSON.stringify(
        {
          handler: "index.mjs",
          launcherType: "Nodejs",
          runtime: "nodejs24.x",
          shouldAddHelpers: false,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeSizedFile(join(adminFunctionRoot, "index.mjs"), options.additionalFunctionBytes);
  }

  await mkdir(join(packageRoot, "dist"), {
    recursive: true,
  });
  const bundledDependencies: BundledDependencyFixture[] = [
    {
      name: "@fixture/local-dep",
      size: 700,
    },
    ...(options.bundledDependencies ?? []),
  ];
  const packageDependencies: Record<string, string> = {};

  for (const dependency of bundledDependencies) {
    packageDependencies[dependency.name] = "1.0.0";
  }

  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "eve-fixture",
        version: "0.0.1",
        bundleDependencies: bundledDependencies.map((dependency) => dependency.name),
        files: ["dist", "README.md"],
        dependencies: packageDependencies,
        peerDependencies: {
          braintrust: ">=3.0.0",
        },
        peerDependenciesMeta: {
          braintrust: {
            optional: true,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeSizedFile(join(packageRoot, "README.md"), 400);
  await writeSizedFile(join(packageRoot, "dist", "index.js"), options.packageIndexBytes ?? 1_600);
  await writeSizedFile(join(packageRoot, "dist", "runtime.js"), options.packageRuntimeBytes ?? 900);

  for (const dependency of bundledDependencies) {
    await writeBundledDependency(packageRoot, dependency);
  }

  return {
    appRoot,
    packageRoot,
  };
}

describe("nitro bundle report", () => {
  it("groups symlinked Vercel functions by their real payload and includes publish metrics", async () => {
    const { appRoot, packageRoot } = await createReportFixture();
    const { collectNitroBundleReport, renderNitroBundleReportMarkdown } =
      await loadBundleReportModule();
    const report = await collectNitroBundleReport({
      appLabel: "apps/fixtures/weather-agent",
      appRoot,
      packageLabel: "packages/eve",
      packageRoot,
    });
    const markdown = renderNitroBundleReportMarkdown(report);

    expect(report.uniqueFunctionCount).toBe(1);
    expect(report.functionAliasCount).toBe(3);
    expect(report.publicRouteCount).toBe(2);
    expect(report.internalRouteCount).toBe(1);
    expect(report.uniqueFunctionBytes).toBe(report.functions[0]?.totalBytes);
    expect(report.uniqueFunctionBytes).toBeGreaterThan(6_000);
    expect(report.staticAssetBytes).toBe(300);
    expect(report.publishedPackage).not.toBeNull();
    expect(report.functions[0]?.publicRoutes).toEqual(["/", "/api/runs"]);
    expect(report.functions[0]?.internalRoutes).toEqual(["/__server"]);
    expect(report.functions[0]?.vcConfig).toEqual({
      handler: "index.mjs",
      launcherType: "Nodejs",
      runtime: "nodejs24.x",
      shouldAddHelpers: false,
    });
    expect(report.functions[0]?.topTracedPackages).toEqual([
      { bytes: 2_000, name: "rolldown" },
      { bytes: 1_000, name: "@scope/pkg" },
    ]);
    expect(report.publishedPackage).toMatchObject({
      installedDependencyBytes: expect.any(Number),
      installedFileCount: expect.any(Number),
      installedPackageBytes: expect.any(Number),
      installedSizeBytes: expect.any(Number),
      packageLabel: "packages/eve",
      packageName: "eve-fixture",
      peerDependencies: [{ name: "braintrust", optional: true, range: ">=3.0.0" }],
      runtimeDependencies: [{ name: "@fixture/local-dep", range: "1.0.0" }],
      version: "0.0.1",
    });
    expect(report.publishedPackage?.publishedFileCount).toBeGreaterThanOrEqual(4);
    expect(report.publishedPackage?.installedSizeBytes).toBeGreaterThan(
      report.publishedPackage?.installedPackageBytes ?? 0,
    );
    expect(report.publishedPackage?.topInstalledPackages.map((pkg) => pkg.name)).toEqual(
      expect.arrayContaining(["@fixture/local-dep", "eve-fixture"]),
    );
    expect(report.publishedPackage?.topPublishedFiles).toEqual(
      expect.arrayContaining([
        { bytes: 1_600, path: "dist/index.js" },
        { bytes: 900, path: "dist/runtime.js" },
      ]),
    );
    expect(report.publishedPackage?.packedSizeBytes).toBeGreaterThan(0);
    expect(report.publishedPackage?.unpackedSizeBytes).toBeGreaterThan(0);
    expect(markdown).toContain("## Bundle + Package Summary: `apps/fixtures/weather-agent`");
    expect(markdown).toContain("**Key takeaways**");
    expect(markdown).toContain("| Area | Metric | Value |");
    expect(markdown).toContain("<summary>Build Metadata</summary>");
    expect(markdown).toContain("<summary>Package Drill-Down</summary>");
    expect(markdown).toContain("### Package Details");
    expect(markdown).toContain("<summary>Function Drill-Down</summary>");
    expect(markdown).toContain("### Top Function Payloads");
    expect(markdown).toContain("### Payload Size Graph");
    expect(markdown).toContain("- Package: tarball");
    expect(markdown).toContain("- Runtime: 1 payload totaling");
    expect(markdown).toContain("Publish payload breakdown");
    expect(markdown).toContain("Installed footprint breakdown");
    expect(markdown).toContain("**Heavy installed dependencies**");
    expect(markdown).toContain("Installed package size");
    expect(markdown).toContain("Installed footprint:");
    expect(markdown).toContain("Published file size");
    expect(markdown).toContain("Runtime dependencies (1)");
    expect(markdown).toContain("Peer dependencies (1)");
    expect(markdown).toContain("`eve-fixture@0.0.1`");
    expect(markdown).toContain("`@fixture/local-dep`");
    expect(markdown).toContain("dist/index.js");
    expect(markdown).toContain("optional peer");
    expect(markdown).toContain("```text");
    expect(markdown).not.toContain("### Published Package: `packages/eve`");
    expect(markdown).not.toContain("### Functions");
    expect(markdown).not.toContain(
      "| Function | Routes | Runtime | Payload | Function Files | Traced Deps |",
    );
    expect(markdown).toContain("| Metric | Value |");
    expect(markdown).toContain("Severity legend");
    expect(markdown).toContain("🔴");
    expect(markdown).toContain("| Public routes | <code>/</code><br><code>/api/runs</code> |");
    expect(markdown).toContain("| Internal aliases | <code>/__server</code> |");
    expect(markdown).not.toContain("Public routes:");
    expect(markdown).toContain("🔎 Dependency Analysis");
    expect(markdown).toContain("Traced dependency size");
    expect(markdown).toContain("Bundled file size");
    expect(markdown).not.toContain("Top traced packages:");
    expect(markdown).not.toContain("Top bundled files:");
    expect(markdown).toContain("| Signal |");
    expect(markdown).toContain("🔎 Traced packages:");
    expect(markdown).toContain("📦 Bundled files:");
    expect(markdown).toContain("**🧾 Vercel Config**");
    expect(markdown).toContain("`apps/fixtures/weather-agent`");
    expect(markdown).toContain("| Runtime | Unique function payloads | 1 |");
    expect(markdown).not.toContain("| Runtime | Static assets |");
    expect(markdown).toContain("<code>/__server</code>");
    expect(markdown).toContain("`rolldown`");
    expect(markdown).toContain("_libs/@workflow+core.mjs");
    expect(markdown).not.toContain("<summary>🧾 <code>.vc-config.json</code></summary>");
    expect(markdown).toContain('"launcherType": "Nodejs"');
  }, 15_000);

  it("renders metric deltas against a main baseline snapshot", async () => {
    const baselineFixture = await createReportFixture();
    const currentFixture = await createReportFixture({
      additionalFunctionBytes: 700,
      packageRuntimeBytes: 1_300,
      serverEntryBytes: 1_700,
      staticAssetBytes: 600,
    });
    const { collectNitroBundleReport, compareNitroBundleReports, renderNitroBundleReportMarkdown } =
      await loadBundleReportModule();
    const baselineReport = await collectNitroBundleReport({
      appLabel: "apps/fixtures/weather-agent",
      appRoot: baselineFixture.appRoot,
      packageLabel: "packages/eve",
      packageRoot: baselineFixture.packageRoot,
    });
    const collectedCurrentReport = await collectNitroBundleReport({
      appLabel: "apps/fixtures/weather-agent",
      appRoot: currentFixture.appRoot,
      packageLabel: "packages/eve",
      packageRoot: currentFixture.packageRoot,
    });
    const currentReport: NitroBundleReport = {
      ...collectedCurrentReport,
      publishedPackage: collectedCurrentReport.publishedPackage
        ? {
            ...collectedCurrentReport.publishedPackage,
            runtimeDependencies: [
              ...collectedCurrentReport.publishedPackage.runtimeDependencies,
              {
                name: "@fixture/new-runtime",
                range: "1.0.0",
              },
            ],
          }
        : null,
    };
    const comparison = compareNitroBundleReports(currentReport, baselineReport, {
      baselineLabel: "main",
    });
    const markdown = renderNitroBundleReportMarkdown({
      ...currentReport,
      comparison,
    });
    const acknowledgedMarkdown = renderNitroBundleReportMarkdown({
      ...currentReport,
      comparison,
      sizeBudgetAcknowledged: true,
    });

    expect(comparison?.baselineLabel).toBe("main");
    expect(comparison?.sizeBudget.failed).toBe(true);
    expect(comparison?.sizeBudget.thresholdRatio).toBe(0.1);
    expect(comparison?.sizeBudget.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: "Runtime",
          failed: true,
          kind: "size",
          metric: "Total function bytes",
          summary: "function payloads",
        }),
        expect.objectContaining({
          area: "Package",
          dependency: "@fixture/new-runtime@1.0.0",
          failed: true,
          kind: "runtime-dependency",
          metric: "Runtime dependency added",
          summary: "runtime dependency @fixture/new-runtime@1.0.0 added",
        }),
      ]),
    );
    expect(comparison?.app.uniqueFunctionCount).toEqual({
      baseline: 1,
      current: 2,
      delta: 1,
    });
    expect(comparison?.app.staticAssetBytes).toEqual({
      baseline: 300,
      current: 600,
      delta: 300,
    });
    expect(comparison?.package?.packedSizeBytes.delta).toBeGreaterThan(0);
    expect(comparison?.package?.unpackedSizeBytes.delta).toBe(400);
    expect(comparison?.package?.installedSizeBytes.delta).toBeGreaterThan(0);
    expect(comparison?.package?.installedDependencyBytes.delta).toBe(0);

    const serverComparison = comparison?.app.functions.find(
      (functionEntry) => functionEntry.relativePath === "functions/__server.func",
    );
    expect(serverComparison?.status).toBe("changed");
    expect(serverComparison?.totalBytes.delta).toBe(200);

    const addedFunction = comparison?.app.functions.find(
      (functionEntry) => functionEntry.relativePath === "functions/admin.func",
    );
    expect(addedFunction?.status).toBe("added");
    expect(addedFunction?.publicRoutesAdded).toEqual(["/admin"]);
    expect(addedFunction?.totalBytes.current).toBeGreaterThan(700);
    expect(comparison?.app.uniqueFunctionBytes.delta).toBe(
      (serverComparison?.totalBytes.delta ?? 0) + (addedFunction?.totalBytes.current ?? 0),
    );

    expect(markdown).toContain("### Delta vs `main`");
    expect(markdown).toContain("❌ Bundle Warning: Action Will Fail");
    expect(markdown).toContain(
      "This action will fail because the bundle warning policy was exceeded.",
    );
    expect(markdown).toContain("Add the `acknowledge-bundle-warning` label");
    expect(markdown).toContain("| Runtime | Total function bytes |");
    expect(markdown).toContain(
      "| Package | Runtime dependency added | New runtime dependency `@fixture/new-runtime@1.0.0` was added.",
    );
    expect(markdown).toContain("function payloads grew");
    expect(markdown).toContain("runtime dependency @fixture/new-runtime@1.0.0 added");
    expect(acknowledgedMarkdown).toContain("⚠️ Bundle Warning Acknowledged");
    expect(acknowledgedMarkdown).toContain(
      "the `acknowledge-bundle-warning` label is present so the check is allowed to pass",
    );
    expect(markdown).toContain("Changed function payloads vs <code>main</code> (2)");
    expect(markdown).not.toContain("| Area | Metric | Value |");
    expect(markdown).toContain("- Package delta:");
    expect(markdown).toContain("- Runtime delta:");
    expect(markdown).not.toContain("- Package: tarball");
    expect(markdown).not.toContain("- Runtime: 2 payloads totaling");
    expect(markdown).not.toContain("| Package | Installed dependencies |");
    expect(markdown).not.toContain("| Runtime | Static assets |");
    expect(markdown).not.toContain("| Runtime | Internal aliases |");
    expect(markdown).not.toContain("| Runtime | Route aliases |");
    expect(markdown).toContain(
      `| Runtime | Total function bytes | ${formatReportBytes(comparison?.app.uniqueFunctionBytes.baseline ?? 0)} | ${formatReportBytes(comparison?.app.uniqueFunctionBytes.current ?? 0)} | ${formatReportSizeDelta(comparison?.app.uniqueFunctionBytes.delta ?? 0)} |`,
    );
    expect(markdown).toContain(
      `| \`functions/admin.func\` | added | 0 B | ${formatReportBytes(addedFunction?.totalBytes.current ?? 0)} | ${formatReportSizeDelta(addedFunction?.totalBytes.delta ?? 0)} |`,
    );
    expect(markdown).toContain(
      `| \`functions/__server.func\` | changed | ${formatReportBytes(serverComparison?.totalBytes.baseline ?? 0)} | ${formatReportBytes(serverComparison?.totalBytes.current ?? 0)} | ${formatReportSizeDelta(serverComparison?.totalBytes.delta ?? 0)} |`,
    );
  }, 15_000);

  it("fails the warning policy when a runtime dependency is added", async () => {
    const fixture = await createReportFixture();
    const { collectNitroBundleReport, compareNitroBundleReports, renderNitroBundleReportMarkdown } =
      await loadBundleReportModule();
    const baselineReport = await collectNitroBundleReport({
      appLabel: "apps/fixtures/weather-agent",
      appRoot: fixture.appRoot,
      packageLabel: "packages/eve",
      packageRoot: fixture.packageRoot,
    });
    const currentReport: NitroBundleReport = {
      ...baselineReport,
      publishedPackage: baselineReport.publishedPackage
        ? {
            ...baselineReport.publishedPackage,
            runtimeDependencies: [
              ...baselineReport.publishedPackage.runtimeDependencies,
              {
                name: "@fixture/new-runtime",
                range: "1.0.0",
              },
            ],
          }
        : null,
    };
    const comparison = compareNitroBundleReports(currentReport, baselineReport, {
      baselineLabel: "main",
    });
    const markdown = renderNitroBundleReportMarkdown({
      ...currentReport,
      comparison,
    });

    expect(comparison?.sizeBudget.failed).toBe(true);
    expect(comparison?.sizeBudget.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          area: "Package",
          dependency: "@fixture/new-runtime@1.0.0",
          failed: true,
          kind: "runtime-dependency",
          metric: "Runtime dependency added",
          summary: "runtime dependency @fixture/new-runtime@1.0.0 added",
        }),
      ]),
    );
    expect(markdown).toContain("❌ Bundle Warning: Action Will Fail");
    expect(markdown).toContain("runtime dependency @fixture/new-runtime@1.0.0 added");
    expect(markdown).toContain("New runtime dependency `@fixture/new-runtime@1.0.0` was added.");
    expect(markdown).toContain("prefer a vendored devDependency");
  }, 15_000);

  it("does not fail the warning policy when an existing runtime dependency range changes", async () => {
    const fixture = await createReportFixture();
    const { collectNitroBundleReport, compareNitroBundleReports, renderNitroBundleReportMarkdown } =
      await loadBundleReportModule();
    const baselineReport = await collectNitroBundleReport({
      appLabel: "apps/fixtures/weather-agent",
      appRoot: fixture.appRoot,
      packageLabel: "packages/eve",
      packageRoot: fixture.packageRoot,
    });
    const runtimeDependency = baselineReport.publishedPackage?.runtimeDependencies[0];

    expect(runtimeDependency).toBeDefined();

    const currentReport: NitroBundleReport = {
      ...baselineReport,
      publishedPackage: baselineReport.publishedPackage
        ? {
            ...baselineReport.publishedPackage,
            runtimeDependencies: baselineReport.publishedPackage.runtimeDependencies.map(
              (dependency) =>
                dependency.name === runtimeDependency?.name
                  ? {
                      ...dependency,
                      range: "9.9.9",
                    }
                  : dependency,
            ),
          }
        : null,
    };
    const comparison = compareNitroBundleReports(currentReport, baselineReport, {
      baselineLabel: "main",
    });
    const markdown = renderNitroBundleReportMarkdown({
      ...currentReport,
      comparison,
    });

    expect(comparison?.sizeBudget.failed).toBe(false);
    expect(comparison?.sizeBudget.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime-dependency",
        }),
      ]),
    );
    expect(comparison?.package?.runtimeDependenciesAdded).toEqual([]);
    expect(comparison?.package?.runtimeDependenciesRemoved).toEqual([]);
    expect(comparison?.package?.runtimeDependenciesChanged).toEqual([
      {
        baseline: `${runtimeDependency?.name}@${runtimeDependency?.range}`,
        current: `${runtimeDependency?.name}@9.9.9`,
        name: runtimeDependency?.name,
      },
    ]);
    expect(markdown).not.toContain("Bundle Warning: Action Will Fail");
    expect(markdown).not.toContain("Runtime dependency added");
    expect(markdown).toContain("Dependency delta: 1 runtime dep changed.");
    expect(markdown).toContain(
      `- Changed: \`${runtimeDependency?.name}@${runtimeDependency?.range}\` -> \`${runtimeDependency?.name}@9.9.9\``,
    );
  }, 15_000);

  it("lists every installed dependency above 5 MB in the footprint breakdown", async () => {
    const largeDependencies: BundledDependencyFixture[] = [
      "@fixture/large-a",
      "@fixture/large-b",
      "@fixture/large-c",
      "@fixture/large-d",
      "@fixture/large-e",
      "@fixture/large-f",
      "@fixture/large-g",
    ].map((name) => ({
      name,
      size: 5_100_000,
    }));
    const { appRoot, packageRoot } = await createReportFixture({
      bundledDependencies: largeDependencies,
    });
    const { collectNitroBundleReport, renderNitroBundleReportMarkdown } =
      await loadBundleReportModule();
    const report = await collectNitroBundleReport({
      appLabel: "apps/fixtures/weather-agent",
      appRoot,
      packageLabel: "packages/eve",
      packageRoot,
    });
    const markdown = renderNitroBundleReportMarkdown(report);
    const installedFootprintBreakdown = markdown
      .split("<summary>Installed footprint breakdown</summary>")[1]
      ?.split("</details>")[0];

    expect(report.publishedPackage?.topInstalledPackages.map((pkg) => pkg.name)).toEqual(
      expect.arrayContaining(largeDependencies.map((dependency) => dependency.name)),
    );
    expect(installedFootprintBreakdown).toBeDefined();
    expect(installedFootprintBreakdown).toContain("@fixture/large-g");
  }, 20_000);

  it("omits repetitive takeaways when the comparison has no notable delta", async () => {
    const fixture = await createReportFixture();
    const { collectNitroBundleReport, compareNitroBundleReports, renderNitroBundleReportMarkdown } =
      await loadBundleReportModule();
    const report = await collectNitroBundleReport({
      appLabel: "apps/fixtures/weather-agent",
      appRoot: fixture.appRoot,
      packageLabel: "packages/eve",
      packageRoot: fixture.packageRoot,
    });
    const comparison = compareNitroBundleReports(report, report, {
      baselineLabel: "main",
    });
    const markdown = renderNitroBundleReportMarkdown({
      ...report,
      comparison,
    });

    expect(markdown).toContain("- No notable deltas vs `main`.");
    expect(markdown).not.toContain("| Area | Metric | Value |");
    expect(markdown).not.toContain("- Package delta:");
    expect(markdown).not.toContain("- Runtime delta:");
    expect(markdown).not.toContain("- Dependency delta:");
    expect(markdown).not.toContain("- Package: tarball");
    expect(markdown).not.toContain("- Runtime: 1 payload totaling");
  }, 15_000);
});

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import {
  resolveInstalledPackageInfo,
  resolvePackageRoot,
  resolvePackageSourceDirectoryPath,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";

import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import type { WorkflowManifest } from "#internal/workflow-bundle/workflow-builders.js";

class InspectableWorkflowBundleBuilder extends WorkflowBundleBuilder {
  readonly outDir: string;

  constructor(options: ConstructorParameters<typeof WorkflowBundleBuilder>[0]) {
    super(options);
    this.outDir = options.outDir;
  }

  get snapshot() {
    return this.config;
  }
}

class StepEntryOnlyWorkflowBundleBuilder extends WorkflowBundleBuilder {
  readonly inputFiles: readonly string[];

  capturedManifest: unknown;
  workflowBundleCalls = 0;

  constructor(
    options: ConstructorParameters<typeof WorkflowBundleBuilder>[0],
    inputFiles: readonly string[],
  ) {
    super(options);
    this.inputFiles = inputFiles;
  }

  protected override async getInputFiles(): Promise<string[]> {
    return [...this.inputFiles];
  }

  protected override async createManifest({
    manifest,
  }: {
    manifest: WorkflowManifest;
    manifestDir: string;
    workflowBundlePath: string;
  }): Promise<string | undefined> {
    this.capturedManifest = manifest;
    return undefined;
  }

  protected override async createWorkflowsBundle(): Promise<{
    bundleFinal?: (interimBundleResult: string) => Promise<void>;
    interimBundleCtx?: undefined;
    manifest: Record<string, never>;
  }> {
    this.workflowBundleCalls += 1;
    return { manifest: {} };
  }
}

class FixtureWorkflowBundleBuilder extends WorkflowBundleBuilder {
  readonly inputFiles: readonly string[];

  constructor(
    options: ConstructorParameters<typeof WorkflowBundleBuilder>[0],
    inputFiles: readonly string[],
  ) {
    super(options);
    this.inputFiles = inputFiles;
  }

  protected override async getInputFiles(): Promise<string[]> {
    return [...this.inputFiles];
  }

  protected override async createManifest(): Promise<string | undefined> {
    return undefined;
  }
}

describe("WorkflowBundleBuilder", () => {
  it("uses the authored app root as the workflow builder project root", () => {
    const appRoot = "/tmp/eve-app";
    const rootDir = resolvePackageRoot();
    const builder = new InspectableWorkflowBundleBuilder({
      agentName: "test-agent",
      appRoot,
      compiledArtifactsBootstrapPath: "/tmp/compiled-artifacts-bootstrap.js",
      outDir: "/tmp/eve-workflows",
      rootDir,
      watch: false,
    });

    expect(builder.snapshot.projectRoot).toBe(appRoot);
    expect(builder.snapshot.workingDir).toBe(rootDir);
    expect(builder.snapshot.dirs).toEqual([resolvePackageSourceDirectoryPath("src/execution")]);
  });

  it("writes a Nitro-owned step registration entry", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-step-entry-"));
    const outDir = join(tempRoot, "workflow-build");
    const stepFilePath = join(tempRoot, "steps", "ping.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");

    try {
      await mkdir(join(tempRoot, "steps"), { recursive: true });
      await Promise.all([
        writeFile(
          compiledArtifactsBootstrapPath,
          "globalThis.__eveCompiledArtifactsInstalled = true;\n",
        ),
        writeFile(
          stepFilePath,
          ["export async function ping() {", '  "use step";', '  return "pong";', "}", ""].join(
            "\n",
          ),
        ),
      ]);

      const builder = new StepEntryOnlyWorkflowBundleBuilder(
        {
          agentName: "test-agent",
          appRoot: tempRoot,
          compiledArtifactsBootstrapPath,
          outDir,
          rootDir: tempRoot,
          watch: false,
        },
        [stepFilePath],
      );

      await builder.build();

      await expect(readFile(join(outDir, "steps.mjs"), "utf8")).resolves.toContain(
        resolveWorkflowModulePath("workflow/internal/builtins"),
      );
      await expect(readFile(join(outDir, "steps.mjs"), "utf8")).resolves.toContain(
        "compiled-artifacts-bootstrap.mjs",
      );
      await expect(readFile(join(outDir, "steps.mjs"), "utf8")).resolves.toContain("steps/ping.ts");
      await expect(readFile(join(outDir, "steps.mjs"), "utf8")).resolves.toContain(
        "export const __steps_registered = true;",
      );
      expect(builder.workflowBundleCalls).toBe(1);
      expect(JSON.stringify(builder.capturedManifest)).toContain("ping");
      expect(JSON.stringify(builder.capturedManifest)).toContain("step//");
      expect(JSON.stringify(builder.capturedManifest)).not.toContain(
        "__eveInstallCompiledArtifactsStep",
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("clears workflow cache output from a different eve version", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-version-cache-"));
    const outDir = join(tempRoot, "workflow-build");
    const stepFilePath = join(tempRoot, "steps", "ping.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");
    const staleCacheFilePath = join(outDir, "stale-cache-output.txt");

    try {
      await Promise.all([
        mkdir(join(tempRoot, "steps"), { recursive: true }),
        mkdir(outDir, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          compiledArtifactsBootstrapPath,
          [
            "export async function __eveInstallCompiledArtifactsStep() {",
            '  "use step";',
            "  return null;",
            "}",
            "",
          ].join("\n"),
        ),
        writeFile(
          stepFilePath,
          ["export async function ping() {", '  "use step";', '  return "pong";', "}", ""].join(
            "\n",
          ),
        ),
        writeFile(
          join(outDir, "eve-cache.json"),
          `${JSON.stringify({ eveVersion: "0.0.0-old" })}\n`,
        ),
        writeFile(staleCacheFilePath, "stale\n"),
      ]);

      const builder = new StepEntryOnlyWorkflowBundleBuilder(
        {
          agentName: "test-agent",
          appRoot: tempRoot,
          compiledArtifactsBootstrapPath,
          outDir,
          rootDir: tempRoot,
          watch: false,
        },
        [stepFilePath],
      );

      await builder.build();

      await expect(readFile(staleCacheFilePath, "utf8")).rejects.toThrow();
      await expect(readFile(join(outDir, "eve-cache.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(
          {
            eveVersion: resolveInstalledPackageInfo().version,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rewrites generated workflow code template literals to parser-safe base64 chunks", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-code-literal-"));
    const outDir = join(tempRoot, "workflow-build");
    const stepFilePath = join(tempRoot, "steps", "ping.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");

    class TemplateLiteralWorkflowBundleBuilder extends FixtureWorkflowBundleBuilder {
      protected override async createWorkflowsBundle({ outfile }: { outfile: string }): Promise<{
        manifest: Record<string, never>;
      }> {
        const workflowBundleCode = [
          "globalThis.__private_workflows = new Map();",
          'const value = `template ${"literal"}`;',
          'const runtimeSpecifier = "workflow/runtime";',
          "//# sourceMappingURL=data:application/json;base64,ZmFrZQ==",
        ].join("\n");

        await writeFile(
          outfile,
          [
            "import { workflowEntrypoint } from 'workflow/runtime';",
            "",
            `const workflowCode = \`${workflowBundleCode.replace(/[\\`$]/g, "\\$&")}\`;`,
            "",
            'export const POST = workflowEntrypoint(workflowCode, { namespace: "eve746573742d6167656e74" });',
            "",
          ].join("\n"),
        );

        return { manifest: {} };
      }
    }

    try {
      await mkdir(join(tempRoot, "steps"), { recursive: true });
      await Promise.all([
        writeFile(
          compiledArtifactsBootstrapPath,
          [
            "export async function __eveInstallCompiledArtifactsStep() {",
            '  "use step";',
            "  return null;",
            "}",
            "",
          ].join("\n"),
        ),
        writeFile(
          stepFilePath,
          ["export async function ping() {", '  "use step";', '  return "pong";', "}", ""].join(
            "\n",
          ),
        ),
      ]);

      const builder = new TemplateLiteralWorkflowBundleBuilder(
        {
          agentName: "test-agent",
          appRoot: tempRoot,
          compiledArtifactsBootstrapPath,
          outDir,
          rootDir: tempRoot,
          watch: false,
        },
        [stepFilePath],
      );

      await builder.build();

      const workflowsSource = await readFile(join(outDir, "workflows.mjs"), "utf8");

      const encodedChunksMatch = workflowsSource.match(
        /Buffer\.from\((\[[\s\S]*?\])\.join\(""\), "base64"\)\.toString\("utf8"\)/,
      );
      expect(encodedChunksMatch).not.toBeNull();

      const encodedChunks = JSON.parse(encodedChunksMatch?.[1] ?? "[]") as string[];
      const decodedWorkflowCode = Buffer.from(encodedChunks.join(""), "base64").toString("utf8");

      expect(workflowsSource).toContain("const workflowCode = Buffer.from([");
      expect(workflowsSource).not.toContain("const workflowCode = `");
      expect(workflowsSource).not.toContain('template ${"literal"}');
      expect(decodedWorkflowCode).toContain('template ${"literal"}');
      expect(decodedWorkflowCode).toContain(
        "sourceMappingURL=data:application/json;base64,ZmFrZQ==",
      );
      expect(workflowsSource).toContain(resolveWorkflowModulePath("workflow/runtime"));

      const workflowsModule = await import(pathToFileURL(join(outDir, "workflows.mjs")).href);

      expect(typeof workflowsModule.POST).toBe("function");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("fails the driver build when a node builtin reaches the workflow body", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-node-leak-"));
    const outDir = join(tempRoot, "workflow-build");
    const flowFilePath = join(tempRoot, "flow.ts");
    const helperFilePath = join(tempRoot, "plain-helper.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");

    try {
      await Promise.all([
        writeFile(
          compiledArtifactsBootstrapPath,
          [
            "export async function __eveInstallCompiledArtifactsStep() {",
            '  "use step";',
            "  return null;",
            "}",
            "",
          ].join("\n"),
        ),
        // A plain (non-`"use step"`) helper that pulls in a node builtin —
        // the same shape as the runtime-actions -> logging -> node:util
        // regression that previously failed at workflow run time.
        writeFile(
          helperFilePath,
          [
            'import { inspect } from "node:util";',
            "export function describeValue(value) {",
            "  return inspect(value);",
            "}",
            "",
          ].join("\n"),
        ),
        writeFile(
          flowFilePath,
          [
            'import { describeValue } from "./plain-helper.ts";',
            "export async function leakyFlow(input) {",
            '  "use workflow";',
            "  return describeValue(input);",
            "}",
            "",
          ].join("\n"),
        ),
      ]);

      const builder = new FixtureWorkflowBundleBuilder(
        {
          agentName: "test-agent",
          appRoot: tempRoot,
          compiledArtifactsBootstrapPath,
          outDir,
          rootDir: tempRoot,
          watch: false,
        },
        [flowFilePath],
      );

      await expect(builder.build()).rejects.toThrow(
        /Workflow bundle cannot import Node\.js builtin "node:util".*use step/s,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("bundles hook ownership checks through the workflow core shim", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-hook-conflict-"));
    const outDir = join(tempRoot, "workflow-build");
    const flowFilePath = join(tempRoot, "flow.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");
    const workflowCoreShimPath = resolvePackageSourceFilePath(
      "src/internal/workflow-bundle/workflow-core-shim.ts",
    ).replaceAll("\\", "/");

    try {
      await Promise.all([
        writeFile(
          compiledArtifactsBootstrapPath,
          [
            "export async function __eveInstallCompiledArtifactsStep() {",
            '  "use step";',
            "  return null;",
            "}",
            "",
          ].join("\n"),
        ),
        writeFile(
          flowFilePath,
          [
            `import { createHook } from ${JSON.stringify(workflowCoreShimPath)};`,
            "export async function claimHook() {",
            '  "use workflow";',
            '  const hook = createHook({ token: "shared-token" });',
            "  const conflict = await hook.getConflict();",
            "  return conflict?.runId ?? null;",
            "}",
            "",
          ].join("\n"),
        ),
      ]);

      const builder = new FixtureWorkflowBundleBuilder(
        {
          agentName: "test-agent",
          appRoot: tempRoot,
          compiledArtifactsBootstrapPath,
          outDir,
          rootDir: resolvePackageRoot(),
          watch: false,
        },
        [flowFilePath],
      );

      await builder.build();

      const workflowsSource = await readFile(join(outDir, "workflows.mjs"), "utf8");
      const encodedChunksMatch = workflowsSource.match(
        /Buffer\.from\((\[[\s\S]*?\])\.join\(""\), "base64"\)\.toString\("utf8"\)/,
      );
      expect(encodedChunksMatch).not.toBeNull();

      const encodedChunks = JSON.parse(encodedChunksMatch?.[1] ?? "[]") as string[];
      const decodedWorkflowCode = Buffer.from(encodedChunks.join(""), "base64").toString("utf8");

      expect(decodedWorkflowCode).toContain("getConflict");
      expect(decodedWorkflowCode).toContain("WORKFLOW_CREATE_HOOK");
      expect(decodedWorkflowCode).not.toContain("runtime/run.js");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("allows a node builtin used only inside a use step body", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-node-step-ok-"));
    const outDir = join(tempRoot, "workflow-build");
    const flowFilePath = join(tempRoot, "flow.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");

    try {
      await Promise.all([
        writeFile(
          compiledArtifactsBootstrapPath,
          [
            "export async function __eveInstallCompiledArtifactsStep() {",
            '  "use step";',
            "  return null;",
            "}",
            "",
          ].join("\n"),
        ),
        // node:crypto is used only inside a `"use step"` function, which the
        // transform stubs out of the driver chunk — the guard must not fire.
        writeFile(
          flowFilePath,
          [
            'import { randomUUID } from "node:crypto";',
            "export async function makeId() {",
            '  "use step";',
            "  return randomUUID();",
            "}",
            "export async function safeFlow() {",
            '  "use workflow";',
            "  return makeId();",
            "}",
            "",
          ].join("\n"),
        ),
      ]);

      const builder = new FixtureWorkflowBundleBuilder(
        {
          agentName: "test-agent",
          appRoot: tempRoot,
          compiledArtifactsBootstrapPath,
          outDir,
          rootDir: tempRoot,
          watch: false,
        },
        [flowFilePath],
      );

      await expect(builder.build()).resolves.toBeUndefined();

      const workflowsSource = await readFile(join(outDir, "workflows.mjs"), "utf8");
      expect(workflowsSource).not.toContain("node:crypto");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

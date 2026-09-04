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
  resolveWorkflowModulePath,
} from "#internal/application/package.js";

import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import { createWorkflowEntrypointSource } from "#internal/workflow-bundle/builder-support.js";
import type { WorkflowManifest } from "#internal/workflow-bundle/workflow-builders.js";

const REQUIRE_EXPORT_MARKER = "eve-workflow-conditional-require-export";
const IMPORT_EXPORT_MARKER = "eve-workflow-conditional-import-export";

async function writeConditionalRequirePackages(root: string): Promise<void> {
  const parentRoot = join(root, "node_modules", "cjs-parent");
  const baseRoot = join(root, "node_modules", "conditional-base");
  await Promise.all([mkdir(parentRoot, { recursive: true }), mkdir(baseRoot, { recursive: true })]);
  await Promise.all([
    writeFile(
      join(parentRoot, "index.cjs"),
      'const Base = require("conditional-base");\nmodule.exports = class Child extends Base {};\n',
    ),
    writeFile(
      join(parentRoot, "package.json"),
      `${JSON.stringify({ main: "./index.cjs", name: "cjs-parent", version: "1.0.0" })}\n`,
    ),
    writeFile(
      join(baseRoot, "import.mjs"),
      `export default { source: ${JSON.stringify(IMPORT_EXPORT_MARKER)} };\n`,
    ),
    writeFile(
      join(baseRoot, "package.json"),
      `${JSON.stringify({
        exports: { ".": { import: "./import.mjs", require: "./require.cjs" } },
        name: "conditional-base",
        type: "module",
        version: "1.0.0",
      })}\n`,
    ),
    writeFile(
      join(baseRoot, "require.cjs"),
      `module.exports = class Base { constructor() { this.source = ${JSON.stringify(REQUIRE_EXPORT_MARKER)}; } };\n`,
    ),
  ]);
}

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
    expect(builder.snapshot.dirs).toEqual([
      resolvePackageSourceDirectoryPath("src/execution"),
      resolvePackageSourceDirectoryPath("src/runtime/subagents"),
      resolvePackageSourceDirectoryPath("src/subagents"),
    ]);
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

  it("writes cache and Nitro workflow entries with target-relative step imports", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-nitro-outputs-"));
    const outDir = join(tempRoot, "workflow-cache");
    const flowFilePath = join(tempRoot, "flow.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");
    const nitroWorkflowOutfile = join(tempRoot, "nitro", "workflow", "workflows.mjs");
    const nitroStepOutfile = join(tempRoot, "nitro", "entries", "steps.mjs");

    try {
      await Promise.all([
        writeFile(compiledArtifactsBootstrapPath, "export {};\n"),
        writeFile(
          flowFilePath,
          [
            "export async function ping() {",
            '  "use step";',
            '  return "pong";',
            "}",
            "export async function flow() {",
            '  "use workflow";',
            "  return ping();",
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

      await builder.build({ nitroStepOutfile, nitroWorkflowOutfile });

      const cacheWorkflowSource = await readFile(join(outDir, "workflows.mjs"), "utf8");
      const nitroWorkflowSource = await readFile(nitroWorkflowOutfile, "utf8");
      expect(cacheWorkflowSource).toContain('from "./steps.mjs";');
      expect(nitroWorkflowSource).toContain('from "../entries/steps.mjs";');
      expect(nitroWorkflowSource).toContain(resolveWorkflowModulePath("workflow/runtime"));
      await expect(readFile(nitroStepOutfile, "utf8")).resolves.toContain(
        "export const __steps_registered = true;",
      );

      for (const source of [cacheWorkflowSource, nitroWorkflowSource]) {
        const encodedChunksMatch = source.match(
          /Buffer\.from\((\[[\s\S]*?\])\.join\(""\), "base64"\)\.toString\("utf8"\)/,
        );
        const encodedChunks = JSON.parse(encodedChunksMatch?.[1] ?? "[]") as string[];
        const workflowCode = Buffer.from(encodedChunks.join(""), "base64").toString("utf8");
        expect(workflowCode).toContain("sourceMappingURL=data:application/json");
        expect(workflowCode).toContain(";base64,");
      }
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("preserves require exports in workflow CommonJS dependencies", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-conditions-"));
    const outDir = join(tempRoot, "workflow-build");
    const flowFilePath = join(tempRoot, "flow.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");

    try {
      await writeConditionalRequirePackages(tempRoot);
      await Promise.all([
        writeFile(compiledArtifactsBootstrapPath, "export {};\n"),
        writeFile(
          flowFilePath,
          [
            'import Child from "cjs-parent";',
            "export async function conditionalWorkflow() {",
            '  "use workflow";',
            "  return new Child().source;",
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

      await builder.build();

      const workflowsSource = await readFile(join(outDir, "workflows.mjs"), "utf8");
      const encodedChunksMatch = workflowsSource.match(
        /Buffer\.from\((\[[\s\S]*?\])\.join\(""\), "base64"\)\.toString\("utf8"\)/,
      );
      const encodedChunks = JSON.parse(encodedChunksMatch?.[1] ?? "[]") as string[];
      const workflowSource = Buffer.from(encodedChunks.join(""), "base64").toString("utf8");
      expect(workflowSource).toContain(REQUIRE_EXPORT_MARKER);
      expect(workflowSource).not.toContain(IMPORT_EXPORT_MARKER);
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

  it("writes generated workflow code as parser-safe base64 chunks", async () => {
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
          createWorkflowEntrypointSource({
            code: workflowBundleCode,
            queueNamespace: "eve746573742d6167656e74",
            stepRegistrationsImport: "./steps.mjs",
          }),
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

  it("fails the driver build when a workflow body calls workflow/api", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-api-in-body-"));
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
        writeFile(
          flowFilePath,
          [
            'import { start } from "workflow/api";',
            "export async function child() {",
            '  "use workflow";',
            "  return 1;",
            "}",
            "export async function parent() {",
            '  "use workflow";',
            "  return await start(child, []);",
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
        /cannot import "workflow\/api".*not available inside a workflow body.*"use step"/s,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("bundles native hook ownership and Run serialization", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-hook-conflict-"));
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
        writeFile(
          flowFilePath,
          [
            'import { createHook } from "workflow";',
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
      expect(decodedWorkflowCode).toContain("class//workflow//Run");
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

  it("bundles authored workflow tools from the application root", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-workflow-bundle-authored-"));
    const appRoot = join(tempRoot, "app");
    const outDir = join(tempRoot, "workflow-build");
    const flowFilePath = join(tempRoot, "flow.ts");
    const compiledArtifactsBootstrapPath = join(tempRoot, "compiled-artifacts-bootstrap.mjs");
    const toolPath = join(appRoot, "agent", "tools", "deploy.ts");
    const stepsPath = join(appRoot, "agent", "lib", "steps.ts");

    try {
      await mkdir(join(appRoot, "agent", "tools"), { recursive: true });
      await mkdir(join(appRoot, "agent", "lib"), { recursive: true });
      await mkdir(join(appRoot, "node_modules", "vendored"), { recursive: true });
      await Promise.all([
        writeFile(compiledArtifactsBootstrapPath, "export {};\n"),
        writeFile(
          flowFilePath,
          ["export async function flow() {", '  "use workflow";', "  return 1;", "}", ""].join(
            "\n",
          ),
        ),
        writeFile(
          join(appRoot, "package.json"),
          `${JSON.stringify({ dependencies: { eve: "*" }, name: "authored-app", version: "0.0.0" })}\n`,
        ),
        // Dependency trees are never authored modules, even with directives.
        writeFile(
          join(appRoot, "node_modules", "vendored", "index.js"),
          'export async function vendored() {\n  "use step";\n}\n',
        ),
        writeFile(
          stepsPath,
          [
            'import { createHash } from "node:crypto";',
            "",
            "export function describePlan(service: string): string {",
            "  return `deploy ${service}`;",
            "}",
            "",
            "export async function hashPlan(plan: string): Promise<string> {",
            '  "use step";',
            '  return createHash("sha256").update(plan).digest("hex");',
            "}",
            "",
          ].join("\n"),
        ),
        writeFile(
          toolPath,
          [
            'import { defineTool } from "eve/tools";',
            'import { sleep } from "workflow";',
            'import { describePlan, hashPlan } from "../lib/steps";',
            "",
            "export default defineTool({",
            '  description: "Deploy a service.",',
            '  inputSchema: { type: "object", properties: { service: { type: "string" } } },',
            "  async execute({ service }: { service: string }) {",
            '    "use workflow";',
            "    const digest = await hashPlan(describePlan(service));",
            '    await sleep("1s");',
            "    return { digest };",
            "  },",
            "});",
            "",
          ].join("\n"),
        ),
      ]);

      const builder = new FixtureWorkflowBundleBuilder(
        {
          agentName: "test-agent",
          appRoot,
          compiledArtifactsBootstrapPath,
          outDir,
          rootDir: resolvePackageRoot(),
          watch: false,
        },
        [flowFilePath],
      );

      await builder.build();

      const stepsSource = await readFile(join(outDir, "steps.mjs"), "utf8");
      expect(stepsSource).toContain("agent/tools/deploy.ts");
      expect(stepsSource).toContain("agent/lib/steps.ts");
      expect(stepsSource).not.toContain("vendored");

      const workflowsSource = await readFile(join(outDir, "workflows.mjs"), "utf8");
      const encodedChunksMatch = workflowsSource.match(
        /Buffer\.from\((\[[\s\S]*?\])\.join\(""\), "base64"\)\.toString\("utf8"\)/,
      );
      const encodedChunks = JSON.parse(encodedChunksMatch?.[1] ?? "[]") as string[];
      const workflowCode = Buffer.from(encodedChunks.join(""), "base64").toString("utf8");
      expect(workflowCode).toContain('"workflow//./agent/tools/deploy//execute"');
      expect(workflowCode).toContain('"step//./agent/lib/steps//hashPlan"');
      expect(workflowCode).toContain("deploy ${service}");
      expect(workflowCode).not.toContain("defineTool");
      expect(workflowCode).not.toContain("node:crypto");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

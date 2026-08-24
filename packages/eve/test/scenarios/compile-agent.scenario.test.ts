import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  COMPILER_DIAGNOSTICS_ARTIFACT_KIND,
  COMPILER_DIAGNOSTICS_ARTIFACT_VERSION,
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  compilerDiagnosticsArtifactSchema,
  createCompileMetadata,
  resolveCompilerArtifactPaths,
  writeCompilerArtifacts,
} from "../../src/compiler/artifacts.js";
import {
  CompileAgentDiagnosticError,
  CompileAgentError,
  compileAgent,
} from "../../src/compiler/compile-agent.js";
import {
  COMPILED_AGENT_MANIFEST_VERSION,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "../../src/compiler/manifest.js";
import { createCompilerWarningDiagnostic } from "../../src/shared/compiler-diagnostics.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "../../src/discover/manifest.js";
import { resolveInstalledPackageInfo } from "../../src/internal/application/package.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import {
  EXTENSION_AGENT_DESCRIPTOR,
  TOOL_OVERRIDES_DESCRIPTOR,
} from "../../src/internal/testing/scenario-apps/index.js";
import { defineInstructions } from "../../src/public/instructions/index.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
} from "../../src/runtime/compiled-artifacts-source.js";
import { withBundledCompiledArtifacts } from "../../src/runtime/loaders/bundled-artifacts.js";
import { loadCompiledArtifactSet } from "../../src/runtime/loaders/compiled-artifact-set.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";

const scenarioApp = useScenarioApp();
const createAppRoot = useTemporaryAppRoots();
const runFile = promisify(execFile);

const APP_ROOT_OPTIONS = { packageName: "test-agent" } as const;
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const ROOT_TYPE_DEFINITIONS = fileURLToPath(
  new URL("../../../../node_modules/@types", import.meta.url),
);
const TSC_BIN_PATH = fileURLToPath(
  new URL("../../../../node_modules/typescript/bin/tsc", import.meta.url),
);
const DEFAULT_AGENT_MODEL_ID = "zai/glm-5.2";
const ALIAS_BUNDLING_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `export default { model: "openai/gpt-5.4-mini" };\n`,
    "agent/alias-root/shared/alias-route.ts":
      'export const rootAliasRoute = "@/shared/alias-route.ts";\n',
    "agent/instructions.md": "You are an alias bundling test agent.\n",
    "agent/lib/alias/lib-route.ts": 'export const libAliasRoute = "@/lib/alias/lib-route.ts";\n',
    "agent/tools/check_alias_paths.ts": `import { libAliasRoute } from "@/lib/alias/lib-route.ts";
import { rootAliasRoute } from "@/shared/alias-route.ts";

export default {
  description: "Return alias path markers from @/ and @/lib/ imports.",
  async execute() {
    return { libAliasRoute, rootAliasRoute };
  },
};
`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          module: "esnext",
          moduleResolution: "bundler",
          paths: {
            "@/lib/*": ["./agent/lib/*"],
            "@/*": ["./agent/alias-root/*"],
          },
          target: "ES2024",
        },
        include: ["agent/**/*"],
      },
      null,
      2,
    )}\n`,
  },
  name: "alias-bundling",
};

describe("compiler artifacts", () => {
  it("uses the framework default model when agent.ts is omitted", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiler-default-model-",
      APP_ROOT_OPTIONS,
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");

    const withoutConfig = await compileAgent({ startPath: appRoot });

    expect(withoutConfig.manifest.config).toMatchObject({
      compaction: {},
      model: {
        contextWindowTokens: expect.any(Number),
        id: DEFAULT_AGENT_MODEL_ID,
      },
      name: "test-agent",
    });
    expect(withoutConfig.manifest.config.source).toEqual({
      exportName: undefined,
      logicalPath: "agent.ts",
      sourceId: "eve.framework-defaults:agent.ts",
      sourceKind: "module",
    });

    await writeFile(join(agentRoot, "agent.mjs"), "export default {};\n");
    await expect(compileAgent({ startPath: appRoot })).rejects.toThrow(
      'The "model" field is required.',
    );
  });

  it("writes stable discovery artifacts under .eve", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compiler-artifacts-", APP_ROOT_OPTIONS);

    await mkdir(join(agentRoot, "channels"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(
      join(agentRoot, "channels", "support.mjs"),
      [
        "export default {",
        '  __kind: "eve:channel",',
        "  routes: [",
        '    { method: "POST", path: "/support", async handler() { return new Response("ok"); } },',
        '    { method: "GET", path: "/support/events", async handler() { return new Response("ok"); } },',
        "  ],",
        '  adapter: { kind: "defineChannel" },',
        "};",
        "",
      ].join("\n"),
    );

    const manifest = createAgentSourceManifest({
      agentId: "test-agent",
      agentRoot,
      appRoot,
      channels: [
        createModuleSourceRef({
          logicalPath: "channels/support.mjs",
        }),
      ],
      configModule: createModuleSourceRef({
        logicalPath: "agent.mjs",
      }),
      diagnostics: [
        createCompilerWarningDiagnostic({
          code: "discover/unsupported-directory",
          message: 'Ignoring unsupported directory "drafts/" in the agent root.',
          nodeId: ROOT_COMPILED_AGENT_NODE_ID,
          sourcePath: join(agentRoot, "drafts"),
        }),
      ],
      instructions: [
        {
          definition: defineInstructions({
            markdown: "You are a precise assistant.",
          }),
          sourceKind: "markdown",
          logicalPath: "instructions.md",
          sourceId: "instructions.md",
        },
      ],
    });

    const writtenArtifacts = await writeCompilerArtifacts({
      appRoot,
      artifactLocations: {
        publishedRoot: join(appRoot, ".eve"),
        writeRoot: join(appRoot, ".eve"),
      },
      defaultWorkflowWorld: "local",
      diagnostics: [
        createCompilerWarningDiagnostic({
          code: "discover/unsupported-directory",
          message: 'Ignoring unsupported directory "drafts/" in the agent root.',
          nodeId: ROOT_COMPILED_AGENT_NODE_ID,
          sourcePath: join(agentRoot, "drafts"),
        }),
      ],
      manifest,
    });

    const [
      compiledManifestText,
      discoveryManifestText,
      diagnosticsText,
      metadataText,
      moduleMapText,
    ] = await Promise.all([
      readFile(writtenArtifacts.paths.compiledManifestPath, "utf8"),
      readFile(writtenArtifacts.paths.discoveryManifestPath, "utf8"),
      readFile(writtenArtifacts.paths.diagnosticsPath, "utf8"),
      readFile(writtenArtifacts.paths.compileMetadataPath, "utf8"),
      readFile(writtenArtifacts.paths.moduleMapPath, "utf8"),
    ]);

    expect(normalizeArtifactValue(JSON.parse(discoveryManifestText), appRoot)).toMatchObject({
      agentId: "test-agent",
      agentRoot: "<app-root>/agent",
      appRoot: "<app-root>",
      diagnosticsSummary: {
        errors: 0,
        warnings: 1,
      },
      channels: [
        {
          logicalPath: "channels/support.mjs",
          sourceId: "channels/support.mjs",
          sourceKind: "module",
        },
      ],
      kind: "eve-agent-discovery-manifest",
      instructions: [
        {
          definition: {
            markdown: "You are a precise assistant.",
          },
          sourceKind: "markdown",
          logicalPath: "instructions.md",
          sourceId: "instructions.md",
        },
      ],
      version: 13,
    });
    expect(normalizeArtifactValue(JSON.parse(compiledManifestText), appRoot)).toMatchObject({
      agentRoot: "<app-root>/agent",
      appRoot: "<app-root>",
      config: {
        compaction: {},
        model: {
          contextWindowTokens: expect.any(Number),
          id: "openai/gpt-5.4",
        },
        name: "test-agent",
      },
      diagnosticsSummary: {
        errors: 0,
        warnings: 1,
      },
      channelRoutes: {
        effective: expect.arrayContaining([
          expect.objectContaining({
            kind: "channel",
            logicalPath: "channels/support.mjs",
            method: "POST",
            name: "support",
            sourceId: "channels/support.mjs",
            sourceKind: "module",
            urlPath: "/support",
          }),
          expect.objectContaining({
            kind: "channel",
            logicalPath: "channels/support.mjs",
            method: "GET",
            name: "support",
            sourceId: "channels/support.mjs",
            sourceKind: "module",
            urlPath: "/support/events",
          }),
        ]),
        preflight: [],
        shadowed: [],
      },
      kind: "eve-agent-compiled-manifest",
      instructions: [
        {
          content: "You are a precise assistant.",
          name: "instructions",
          logicalPath: "instructions.md",
          role: "system",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      ],
      version: COMPILED_AGENT_MANIFEST_VERSION,
    });
    expect(normalizeArtifactValue(JSON.parse(diagnosticsText), appRoot)).toMatchObject({
      diagnostics: [
        {
          code: "discover/unsupported-directory",
          message: 'Ignoring unsupported directory "drafts/" in the agent root.',
          severity: "warning",
          sourcePath: "<app-root>/agent/drafts",
        },
      ],
      kind: COMPILER_DIAGNOSTICS_ARTIFACT_KIND,
      summary: {
        errors: 0,
        warnings: 1,
      },
      version: COMPILER_DIAGNOSTICS_ARTIFACT_VERSION,
    });
    const compileMetadata = JSON.parse(metadataText) as {
      generator: {
        name: string;
        version: string;
      };
    };

    expect(compileMetadata.generator).toEqual(resolveInstalledPackageInfo());
    expect(normalizeCompileMetadata(compileMetadata)).toMatchObject({
      compile: {
        manifest: {
          path: ".eve/compile/compiled-agent-manifest.json",
          sha256: "<sha256>",
        },
        moduleMap: {
          path: ".eve/compile/module-map.mjs",
          sha256: "<sha256>",
        },
      },
      discovery: {
        diagnostics: {
          path: ".eve/discovery/diagnostics.json",
          sha256: "<sha256>",
        },
        manifest: {
          path: ".eve/discovery/agent-discovery-manifest.json",
          sha256: "<sha256>",
        },
        sourceGraphHash: "<sha256>",
        summary: {
          errors: 0,
          warnings: 1,
        },
      },
      generator: {
        name: "<package-name>",
        version: "<package-version>",
      },
      kind: "eve-compile-metadata",
      status: "ready",
      version: COMPILE_METADATA_VERSION,
    });
    expect(moduleMapText).toContain('"nodes": Object.freeze({');
    expect(moduleMapText).toContain(`"${ROOT_COMPILED_AGENT_NODE_ID}": Object.freeze({`);
    expect(moduleMapText).toContain('"agent.mjs": Object.freeze({');
    expect(moduleMapText).not.toContain('"subagents": Object.freeze({');
  });

  it("persists route-selection warnings through artifacts, summaries, and hashes", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiler-route-warning-",
      APP_ROOT_OPTIONS,
    );
    await mkdir(join(agentRoot, "channels"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    const channelModule = [
      "export default {",
      '  __kind: "eve:channel",',
      '  routes: [{ method: "GET", path: "/shared", async handler() { return new Response("ok"); } }],',
      '  adapter: { kind: "defineChannel" },',
      "};",
      "",
    ].join("\n");
    await Promise.all([
      writeFile(join(agentRoot, "channels", "alpha.mjs"), channelModule),
      writeFile(join(agentRoot, "channels", "beta.mjs"), channelModule),
    ]);

    const written = await writeCompilerArtifacts({
      appRoot,
      artifactLocations: {
        publishedRoot: join(appRoot, ".eve"),
        writeRoot: join(appRoot, ".eve"),
      },
      defaultWorkflowWorld: "local",
      diagnostics: [],
      manifest: createAgentSourceManifest({
        agentId: "test-agent",
        agentRoot,
        appRoot,
        channels: [
          createModuleSourceRef({ logicalPath: "channels/alpha.mjs" }),
          createModuleSourceRef({ logicalPath: "channels/beta.mjs" }),
        ],
        configModule: createModuleSourceRef({ logicalPath: "agent.mjs" }),
      }),
    });

    expect(
      written.compiledManifest.channelRoutes.effective.filter(
        (route) => route.urlPath === "/shared",
      ),
    ).toEqual([expect.objectContaining({ sourceId: "channels/alpha.mjs", urlPath: "/shared" })]);
    expect(written.compiledManifest.channelRoutes.shadowed).toEqual([
      expect.objectContaining({
        loser: expect.objectContaining({
          binding: expect.objectContaining({ logicalPath: "channels/beta.mjs" }),
          route: expect.objectContaining({ sourceId: "channels/beta.mjs" }),
        }),
        method: "GET",
        pathPattern: "/shared",
        winningSourceId: "channels/alpha.mjs",
      }),
    ]);
    expect(written.diagnosticsArtifact.diagnostics).toEqual([
      expect.objectContaining({
        channelRoute: { method: "GET", pathPattern: "/shared" },
        code: "compile/channel-route-shadowed",
        logicalPath: "channels/beta.mjs",
        related: [
          expect.objectContaining({
            logicalPath: "channels/alpha.mjs",
            sourceId: "channels/alpha.mjs",
          }),
        ],
        severity: "warning",
        sourceId: "channels/beta.mjs",
      }),
    ]);
    expect(written.compiledManifest.diagnosticsSummary).toEqual({ errors: 0, warnings: 1 });
    expect(written.metadata.discovery.summary).toEqual({ errors: 0, warnings: 1 });

    const persistedDiagnostics = JSON.parse(
      await readFile(written.paths.diagnosticsPath, "utf8"),
    ) as unknown;
    expect(compilerDiagnosticsArtifactSchema.parse(persistedDiagnostics)).toEqual(
      written.diagnosticsArtifact,
    );
    expect(written.metadata.discovery.sourceGraphHash).toMatch(/^[a-f\d]{64}$/u);
  });

  it("renders route-planning failures with primary and related provenance without artifacts", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiler-route-failure-",
      APP_ROOT_OPTIONS,
    );
    await mkdir(join(agentRoot, "channels"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "channels", "duplicate.mjs"),
      [
        "export default {",
        '  __kind: "eve:channel",',
        "  routes: [",
        '    { method: "GET", path: "/duplicate/:id", async handler() { return new Response("ok"); } },',
        '    { method: "GET", path: "/duplicate/:name", async handler() { return new Response("ok"); } },',
        "  ],",
        '  adapter: { kind: "defineChannel" },',
        "};",
        "",
      ].join("\n"),
    );

    const error = await compileAgent({ startPath: appRoot }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompileAgentDiagnosticError);
    expect((error as Error).message).toContain("Error [compile/channel-route-duplicate]");
    expect((error as Error).message).toContain(
      "source: __root__ · channels/duplicate.mjs · channels/duplicate.mjs",
    );
    expect((error as Error).message).toContain(
      "related (first declaration): __root__ · channels/duplicate.mjs · channels/duplicate.mjs",
    );
    expect((error as Error).message).not.toContain("Diagnostics artifact:");
    await expect(
      readFile(resolveCompilerArtifactPaths(appRoot).diagnosticsPath, "utf8"),
    ).rejects.toThrow();
  });

  it("generates a recursive module map for module-backed authored sources", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compiler-module-map-",
      APP_ROOT_OPTIONS,
    );
    const reviewerRoot = join(agentRoot, "subagents", "reviewer");

    await mkdir(join(agentRoot, "schedules", "daily-digest"), {
      recursive: true,
    });
    await mkdir(join(agentRoot, "skills"), {
      recursive: true,
    });
    await mkdir(join(agentRoot, "tools"), {
      recursive: true,
    });
    await mkdir(join(reviewerRoot, "tools"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(
      join(agentRoot, "instructions.mjs"),
      'export default { markdown: "Root instructions prompt." };\n',
    );
    await writeFile(
      join(agentRoot, "schedules", "daily-digest.mjs"),
      'export default { cron: "0 8 * * *", markdown: "Send a digest." };\n',
    );
    await writeFile(
      join(agentRoot, "skills", "route.mjs"),
      'export default { description: "Route requests.", markdown: "Route requests." };\n',
    );
    await writeFile(
      join(agentRoot, "tools", "get_weather.mjs"),
      'export default { description: "Get the weather.", async execute(input) { return input; } };\n',
    );
    await writeFile(
      join(reviewerRoot, "agent.mjs"),
      'export default { model: "openai/gpt-5.4", description: "Review one draft." };\n',
    );
    await writeFile(
      join(reviewerRoot, "instructions.mjs"),
      'export default { markdown: "Reviewer instructions prompt." };\n',
    );
    await writeFile(
      join(reviewerRoot, "tools", "review.mjs"),
      'export default { description: "Review content.", async execute(input) { return input; } };\n',
    );

    const reviewerManifest = createAgentSourceManifest({
      agentRoot: reviewerRoot,
      appRoot,
      instructions: [
        createModuleSourceRef({
          logicalPath: "instructions.mjs",
        }),
      ],
      tools: [
        createModuleSourceRef({
          logicalPath: "tools/review.mjs",
        }),
      ],
      configModule: createModuleSourceRef({
        logicalPath: "agent.mjs",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentRoot,
      appRoot,
      configModule: createModuleSourceRef({
        logicalPath: "agent.mjs",
      }),
      instructions: [
        createModuleSourceRef({
          logicalPath: "instructions.mjs",
        }),
      ],
      schedules: [
        createModuleSourceRef({
          logicalPath: "schedules/daily-digest.mjs",
        }),
      ],
      skills: [
        createModuleSourceRef({
          logicalPath: "skills/route.mjs",
        }),
      ],
      tools: [
        createModuleSourceRef({
          logicalPath: "tools/get_weather.mjs",
        }),
      ],
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: reviewerRoot,
          logicalPath: "subagents/reviewer",
          manifest: reviewerManifest,
          rootPath: reviewerRoot,
          subagentId: "reviewer",
        }),
      ],
    });

    const writtenArtifacts = await writeCompilerArtifacts({
      appRoot,
      artifactLocations: {
        publishedRoot: join(appRoot, ".eve"),
        writeRoot: join(appRoot, ".eve"),
      },
      defaultWorkflowWorld: "local",
      diagnostics: [],
      manifest,
    });
    const moduleMapText = await readFile(writtenArtifacts.paths.moduleMapPath, "utf8");

    const normalizedModuleMapText = normalizeArtifactValue(moduleMapText.trimEnd(), appRoot);

    // Authored instructions modules execute once at build time and are baked into the
    // compiled manifest as markdown. They never appear in the module map.
    expect(normalizedModuleMapText).not.toContain("instructions.mjs");
    expect(normalizedModuleMapText).toContain('"load": () => import("../../agent/agent.mjs")');
    expect(normalizedModuleMapText).toContain("../../agent/tools/get_weather.mjs");
    expect(normalizedModuleMapText).toContain("../../agent/subagents/reviewer/agent.mjs");
    expect(normalizedModuleMapText).toContain("../../agent/subagents/reviewer/tools/review.mjs");
    expect(normalizedModuleMapText).toContain('"nodes": Object.freeze({');
    expect(normalizedModuleMapText).toContain(`"${ROOT_COMPILED_AGENT_NODE_ID}": Object.freeze({`);
    expect(normalizedModuleMapText).toContain('"agent.mjs": Object.freeze({');
    expect(normalizedModuleMapText).toContain('"tools/get_weather.mjs": Object.freeze({');
    expect(normalizedModuleMapText).toContain('"subagents/reviewer": Object.freeze({');
    expect(normalizedModuleMapText).toContain('"agent.mjs": Object.freeze({');
    expect(normalizedModuleMapText).toContain('"tools/review.mjs": Object.freeze({');
  });

  it("records versioned artifact hashes in compile metadata", () => {
    const appRoot = "/tmp/weather-agent";
    const paths = resolveCompilerArtifactPaths(appRoot);
    const firstMetadata = createCompileMetadata({
      appRoot,
      compiledManifestJson: '{"kind":"eve-agent-compiled-manifest"}\n',
      diagnosticsArtifactJson: '{"kind":"eve-compiler-diagnostics"}\n',
      diagnosticsSummary: {
        errors: 0,
        warnings: 1,
      },
      discoveryManifestJson: '{"kind":"eve-agent-discovery-manifest","agentId":"weather-agent"}\n',
      moduleMapIdentity: "f".repeat(64),
      moduleMapSource: "export const moduleMap = {};\n",
      paths,
    });
    const secondMetadata = createCompileMetadata({
      appRoot,
      compiledManifestJson: '{"kind":"eve-agent-compiled-manifest"}\n',
      diagnosticsArtifactJson: '{"kind":"eve-compiler-diagnostics"}\n',
      diagnosticsSummary: {
        errors: 0,
        warnings: 1,
      },
      discoveryManifestJson:
        '{"kind":"eve-agent-discovery-manifest","agentId":"weather-agent-v2"}\n',
      moduleMapIdentity: "f".repeat(64),
      moduleMapSource: "export const moduleMap = {};\n",
      paths,
    });
    const changedCompiledManifestMetadata = createCompileMetadata({
      appRoot,
      compiledManifestJson: '{"kind":"eve-agent-compiled-manifest","routes":[]}\n',
      diagnosticsArtifactJson: '{"kind":"eve-compiler-diagnostics"}\n',
      diagnosticsSummary: {
        errors: 0,
        warnings: 1,
      },
      discoveryManifestJson: '{"kind":"eve-agent-discovery-manifest","agentId":"weather-agent"}\n',
      moduleMapIdentity: "f".repeat(64),
      moduleMapSource: "export const moduleMap = {};\n",
      paths,
    });

    expect(firstMetadata.kind).toBe(COMPILE_METADATA_KIND);
    expect(firstMetadata.version).toBe(COMPILE_METADATA_VERSION);
    expect(firstMetadata.compile.moduleMap.path).toBe(".eve/compile/module-map.mjs");
    expect(firstMetadata.discovery.manifest.path).toBe(
      ".eve/discovery/agent-discovery-manifest.json",
    );
    expect(firstMetadata.discovery.diagnostics.path).toBe(".eve/discovery/diagnostics.json");
    expect(firstMetadata.discovery.manifest.sha256).not.toBe(
      secondMetadata.discovery.manifest.sha256,
    );
    expect(firstMetadata.discovery.sourceGraphHash).not.toBe(
      secondMetadata.discovery.sourceGraphHash,
    );
    expect(firstMetadata.compile.manifest.sha256).not.toBe(
      changedCompiledManifestMetadata.compile.manifest.sha256,
    );
    expect(firstMetadata.discovery.sourceGraphHash).not.toBe(
      changedCompiledManifestMetadata.discovery.sourceGraphHash,
    );
  });
});

describe("compileAgent", () => {
  it("renders and transports a successful route-shadow warning exactly", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-agent-route-warning-",
      APP_ROOT_OPTIONS,
    );
    await mkdir(join(agentRoot, "channels"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "Answer precisely.\n");
    const channelModule = [
      "export default {",
      '  __kind: "eve:channel",',
      '  routes: [{ method: "GET", path: "/shared", async handler() { return new Response("ok"); } }],',
      '  adapter: { kind: "defineChannel" },',
      "};",
      "",
    ].join("\n");
    await Promise.all([
      writeFile(join(agentRoot, "channels", "alpha.mjs"), channelModule),
      writeFile(join(agentRoot, "channels", "beta.mjs"), channelModule),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const compiled = await compileAgent({ startPath: appRoot });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        [
          'Warning [compile/channel-route-shadowed]: GET /shared from "channels/beta.mjs" is shadowed by "channels/alpha.mjs".',
          "  source: __root__ · channels/beta.mjs · channels/beta.mjs",
          "  related (winner): __root__ · channels/alpha.mjs · channels/alpha.mjs",
        ].join("\n"),
      );

      const diskArtifacts = await loadCompiledArtifactSet({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      });
      expect(diskArtifacts.diagnostics.diagnostics).toEqual(compiled.diagnostics);

      await withBundledCompiledArtifacts(
        { ...diskArtifacts, sessionId: "route-warning-artifact-transport" },
        async () => {
          const bundledArtifacts = await loadCompiledArtifactSet({
            compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          });

          expect(bundledArtifacts.diagnostics).toEqual(diskArtifacts.diagnostics);
        },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("narrows authored channel metadata without generated declarations", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/channels/support.ts": [
          'import { defineChannel, POST } from "eve/channels";',
          "",
          "export default defineChannel({",
          "  state: { queueId: null as string | null },",
          '  routes: [POST("/support", async () => new Response("ok"))],',
          '  metadata: (state) => ({ priority: "high" as const, queueId: state.queueId }),',
          "});",
          "",
        ].join("\n"),
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/instrumentation.ts": [
          'import { defineInstrumentation, isChannel } from "eve/instrumentation";',
          'import supportChannel from "./channels/support.js";',
          "",
          "export default defineInstrumentation({",
          "  events: {",
          '    "step.started"(input) {',
          "      if (!isChannel(input.channel, supportChannel)) return undefined;",
          "      const queueId: string | null = input.channel.metadata.queueId;",
          '      const priority: "high" = input.channel.metadata.priority;',
          "      // @ts-expect-error channel metadata contains no arbitrary fallback keys.",
          "      input.channel.metadata.missing;",
          '      return { runtimeContext: { "support.has_queue": String(queueId !== null), "support.priority": priority } };',
          "    },",
          "  },",
          "});",
          "",
        ].join("\n"),
      },
      installDependencies: true,
      name: "authored-channel-metadata",
    });
    const appRoot = app.appRoot;
    await writeFile(
      join(appRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            lib: ["ES2024", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2024",
            typeRoots: [ROOT_TYPE_DEFINITIONS],
            types: ["node"],
          },
          include: ["agent/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );

    await expectTscToPass([TSC_BIN_PATH, "-p", join(appRoot, "tsconfig.json")], {
      cwd: REPO_ROOT,
    });
  });

  it("composes a mounted extension's tools into the consuming agent", async () => {
    const app = await scenarioApp({
      name: "mounted-extension",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/index.mjs" },
        })}\n`,
        "node_modules/@acme/crm/extension/_manifest.json": JSON.stringify({
          kind: "eve-extension",
          formatVersion: 2,
          builtWithEve: "0.0.0-test",
          build: { externalDependencies: [] },
          requires: { extension: 1, tool: 1, instructions: 1 },
        }),
        "node_modules/@acme/crm/extension/index.mjs": "export default {};\n",
        "node_modules/@acme/crm/extension/instructions/policy.mjs":
          'export default { markdown: "Prefer the CRM over guessing." };\n',
        "node_modules/@acme/crm/extension/tools/crm_search.mjs": [
          'import { defineTool } from "eve/tools";',
          "",
          "export default defineTool({",
          '  description: "Search the CRM.",',
          '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
          "  async execute() {",
          "    return { ok: true };",
          "  },",
          "});",
          "",
        ].join("\n"),
      },
    });

    const result = await compileAgent({ startPath: app.appRoot });

    expect(result.manifest.tools.map((tool) => tool.name)).toContain("crm__crm_search");
    const composed = result.manifest.tools.find((tool) => tool.name === "crm__crm_search");
    expect(composed?.sourceId).toBe("ext:crm:tools/crm_search.mjs");
    expect(composed?.description).toBe("Search the CRM.");
    expect(result.manifest.instructions.map((entry) => entry.content).join("\n")).toContain(
      "Prefer the CRM over guessing.",
    );

    const moduleMapText = await readFile(result.paths.moduleMapPath, "utf8");
    expect(moduleMapText).toContain("@acme/crm/extension/tools/crm_search.mjs");
    expect(moduleMapText).toContain('"ext:crm:tools/crm_search.mjs"');
  });

  it("never evaluates or emits a shadowed extension definition", async () => {
    const app = await scenarioApp({
      name: "shadowed-extension-definition",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "agent/instructions.md": "Use the selected application tool.\n",
        "agent/tools/crm__search.mjs": [
          "export default {",
          '  description: "Application search winner.",',
          '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
          "  async execute() { return { selected: true }; },",
          "};",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/index.mjs" },
        })}\n`,
        "node_modules/@acme/crm/extension/_manifest.json": JSON.stringify({
          kind: "eve-extension",
          formatVersion: 2,
          builtWithEve: "0.0.0-test",
          build: { externalDependencies: [] },
          requires: { extension: 1, tool: 1 },
        }),
        "node_modules/@acme/crm/extension/index.mjs": "export default {};\n",
        "node_modules/@acme/crm/extension/tools/search.mjs": [
          'throw new Error("shadowed extension tool executed");',
          "export default {};",
          "",
        ].join("\n"),
      },
    });

    const result = await compileAgent({ startPath: app.appRoot });
    const selected = result.manifest.tools.find((tool) => tool.name === "crm__search");
    const moduleMapText = await readFile(result.paths.moduleMapPath, "utf8");

    expect(selected).toMatchObject({
      description: "Application search winner.",
      sourceId: "tools/crm__search.mjs",
    });
    expect(result.manifest.bindings).not.toHaveProperty("ext:crm:tools/search.mjs");
    expect(moduleMapText).not.toContain("@acme/crm/extension/tools/search.mjs");
    expect(moduleMapText).not.toContain('"ext:crm:tools/search.mjs"');
  });

  it("compiles extension-variant authored modules from a fixture app", async () => {
    const app = await scenarioApp(EXTENSION_AGENT_DESCRIPTOR);

    const result = await compileAgent({
      startPath: app.appRoot,
    });
    const moduleMapText = await readFile(result.paths.moduleMapPath, "utf8");

    expect(result.manifest.config).toMatchObject({
      model: {
        id: "openai/gpt-5.4",
      },
      name: "extension-agent",
      source: {
        sourceKind: "module",
        logicalPath: "agent.cjs",
        sourceId: "agent.cjs",
      },
    });
    expect(result.manifest.schedules).toEqual([
      {
        cron: "0 0 * * *",
        hasRun: false,
        name: "nightly",
        logicalPath: "schedules/nightly.cts",
        markdown: "Run the nightly extension fixture schedule.",
        sourceId: "schedules/nightly.cts",
        sourceKind: "module",
      },
    ]);
    expect(result.manifest.skills).toEqual([
      {
        description: "Hand off the task to the next specialist.",
        logicalPath: "skills/handoff.mts",
        markdown: "Use this skill when routing tasks across specialized agents.",
        name: "handoff",
        sourceId: "skills/handoff.mts",
        sourceKind: "module",
      },
    ]);
    expect(
      result.manifest.tools.find((tool) => tool.sourceId === "tools/get_weather.mts"),
    ).toMatchObject({
      description:
        "Get weather details using lib extension imports through mixed extension loading across cjs/js/mts/mjs modules.",
      inputSchema: null,
      logicalPath: "tools/get_weather.mts",
      name: "get_weather",
      sourceId: "tools/get_weather.mts",
      sourceKind: "module",
    });
    expect(result.manifest.sandbox).toEqual({
      backendName: undefined,
      description: undefined,
      exportName: undefined,
      hasBootstrap: false,
      hasOnSession: true,
      inheritsParent: undefined,
      logicalPath: "sandbox/sandbox.cjs",
      revalidationKey: undefined,
      sourceHash: expect.any(String),
      sourceId: "sandbox/sandbox.cjs",
      sourceKind: "module",
    });
    expect(normalizeArtifactValue(moduleMapText, app.appRoot)).toContain(
      '"agent.cjs": Object.freeze({',
    );
    expect(normalizeArtifactValue(moduleMapText, app.appRoot)).toContain(
      '"sandbox/sandbox.cjs": Object.freeze({',
    );
    expect(normalizeArtifactValue(moduleMapText, app.appRoot)).toContain(
      '"tools/get_weather.mts": Object.freeze({',
    );
  });

  it("compiles tools that import from @/ and @/lib/* aliases", async () => {
    const app = await scenarioApp(ALIAS_BUNDLING_DESCRIPTOR);

    const result = await compileAgent({
      startPath: app.appRoot,
    });

    expect(
      result.manifest.tools.find((tool) => tool.sourceId === "tools/check_alias_paths.ts"),
    ).toMatchObject({
      description: "Return alias path markers from @/ and @/lib/ imports.",
      inputSchema: null,
      logicalPath: "tools/check_alias_paths.ts",
      name: "check_alias_paths",
      sourceId: "tools/check_alias_paths.ts",
      sourceKind: "module",
    });
  });

  it("compiles a fixture that wraps, disables, and replaces framework tools", async () => {
    const app = await scenarioApp(TOOL_OVERRIDES_DESCRIPTOR);

    const result = await compileAgent({
      startPath: app.appRoot,
    });

    expect(result.manifest.kernelPlan.prepared).toEqual(["ask_question", "final_output"]);

    // Both the wrapped bash and the replacement todo land in `tools` as
    // ordinary CompiledToolDefinitions. The web_fetch override is intentionally
    // absent — the disable sentinel is partitioned out before this point.
    const toolsByName = new Map(result.manifest.tools.map((tool) => [tool.name, tool]));

    expect([...toolsByName.keys()].sort()).toEqual([
      "bash",
      "load_skill",
      "read_file",
      "todo",
      "write_file",
    ]);

    expect(toolsByName.get("bash")).toMatchObject({
      description: "Run a vetted shell command in the project sandbox.",
      logicalPath: "tools/bash.ts",
      name: "bash",
      sourceId: "tools/bash.ts",
      sourceKind: "module",
    });
    expect(toolsByName.get("todo")).toMatchObject({
      description: "Append a note or read the running list of notes.",
      logicalPath: "tools/todo.ts",
      name: "todo",
      sourceId: "tools/todo.ts",
      sourceKind: "module",
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("compiles authored modules from cjs and cts extensions", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-extension-variants-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "schedules"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "agent.cjs"),
      ["module.exports = {", '  model: "openai/gpt-5.4",', "};", ""].join("\n"),
    );
    await writeFile(
      join(agentRoot, "schedules", "cleanup.cts"),
      'export default { cron: "0 0 * * *", markdown: "Clean stale workflow state." };\n',
    );

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.config).toMatchObject({
      model: {
        id: "openai/gpt-5.4",
      },
      name: "test-agent",
      source: {
        sourceKind: "module",
        logicalPath: "agent.cjs",
        sourceId: "agent.cjs",
      },
    });
    expect(result.manifest.schedules).toEqual([
      {
        cron: "0 0 * * *",
        hasRun: false,
        name: "cleanup",
        logicalPath: "schedules/cleanup.cts",
        markdown: "Clean stale workflow state.",
        sourceId: "schedules/cleanup.cts",
        sourceKind: "module",
      },
    ]);
  });

  it("materializes TypeScript-authored skill package files as workspace resources", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-dynamic-skill-files-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "skills"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "skills", "research.mjs"),
      [
        "export default {",
        '  description: "Research unfamiliar topics.",',
        '  markdown: "Gather evidence first.",',
        "  files: {",
        '    "references/checklist.md": "# Checklist\\n\\n- Find primary sources.\\n",',
        '    "assets/query-template.bin": new Uint8Array([0, 1, 255]),',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });
    const skillRoot = join(
      result.paths.compileDirectoryPath,
      "workspace-resources",
      ROOT_COMPILED_AGENT_NODE_ID,
      "skills",
      "research",
    );
    const [skillMarkdown, checklist, asset, compiledManifestText, moduleMapText] =
      await Promise.all([
        readFile(join(skillRoot, "SKILL.md"), "utf8"),
        readFile(join(skillRoot, "references", "checklist.md"), "utf8"),
        readFile(join(skillRoot, "assets", "query-template.bin")),
        readFile(result.paths.compiledManifestPath, "utf8"),
        readFile(result.paths.moduleMapPath, "utf8"),
      ]);

    expect(skillMarkdown).toBe("Gather evidence first.");
    expect(checklist).toBe("# Checklist\n\n- Find primary sources.\n");
    expect(asset).toEqual(Buffer.from([0, 1, 255]));
    expect(result.manifest.skills).toEqual([
      {
        description: "Research unfamiliar topics.",
        logicalPath: "skills/research.mjs",
        markdown: "Gather evidence first.",
        name: "research",
        sourceId: "skills/research.mjs",
        sourceKind: "module",
      },
    ]);
    expect(compiledManifestText).not.toContain("Find primary sources");
    expect(compiledManifestText).not.toContain("query-template.bin");
    expect(moduleMapText).not.toContain("Find primary sources");
  });

  it("compiles nested authored tools using the path-derived tool name", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-nested-tools-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "tools", "billing"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "tools", "ping.ts"),
      'export default { description: "Ping.", async execute(input) { return input; } };\n',
    );
    await writeFile(
      join(agentRoot, "tools", "billing", "refund.ts"),
      'export default { description: "Refund a charge.", async execute(input) { return input; } };\n',
    );

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(
      result.manifest.tools.filter((tool) => tool.sourceId.startsWith("tools/")),
    ).toMatchObject([
      {
        description: "Refund a charge.",
        inputSchema: null,
        logicalPath: "tools/billing/refund.ts",
        name: "billing-refund",
        sourceId: "tools/billing/refund.ts",
        sourceKind: "module",
      },
      {
        description: "Ping.",
        inputSchema: null,
        logicalPath: "tools/ping.ts",
        name: "ping",
        sourceId: "tools/ping.ts",
        sourceKind: "module",
      },
    ]);
  });

  it("compiles authored schedules into deterministic manifest entries (module + markdown forms)", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compile-schedules-", APP_ROOT_OPTIONS);

    await mkdir(join(agentRoot, "schedules"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "schedules", "daily-digest.mjs"),
      `export default {
  cron: "0 8 * * *",
  async run({ waitUntil }) {
    waitUntil(Promise.resolve("ok"));
  },
};
`,
    );
    await writeFile(
      join(agentRoot, "schedules", "cleanup.md"),
      '---\ncron: "0 0 * * 0"\n---\nClean up stale data.',
    );
    await writeFile(
      join(agentRoot, "schedules", "heartbeat.mjs"),
      'export default { cron: "*/1 * * * *", markdown: "Heartbeat — no channel." };\n',
    );

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.schedules).toEqual([
      {
        cron: "0 0 * * 0",
        hasRun: false,
        name: "cleanup",
        logicalPath: "schedules/cleanup.md",
        markdown: "Clean up stale data.",
        sourceId: "schedules/cleanup.md",
        sourceKind: "markdown",
      },
      {
        cron: "0 8 * * *",
        hasRun: true,
        name: "daily-digest",
        logicalPath: "schedules/daily-digest.mjs",
        sourceId: "schedules/daily-digest.mjs",
        sourceKind: "module",
      },
      {
        cron: "*/1 * * * *",
        hasRun: false,
        name: "heartbeat",
        logicalPath: "schedules/heartbeat.mjs",
        markdown: "Heartbeat — no channel.",
        sourceId: "schedules/heartbeat.mjs",
        sourceKind: "module",
      },
    ]);
  });

  it("rejects unsupported inline local subagent fields instead of silently dropping them", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-subagent-shape-",
      APP_ROOT_OPTIONS,
    );
    const subagentRoot = join(agentRoot, "subagents", "researcher");

    await mkdir(subagentRoot, {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(join(subagentRoot, "instructions.md"), "Research tasks deeply.");
    await writeFile(
      join(subagentRoot, "agent.mjs"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        '  description: "Investigate one task in depth.",',
        "  tools: [],",
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      compileAgent({
        startPath: appRoot,
      }),
    ).rejects.toThrow(
      'Expected the agent config export "default" from "subagents/researcher/agent.mjs"',
    );
  });

  it("rejects legacy workspace kind fields in authored agent config modules", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-workspace-shape-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "agent.mjs"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        '  workspace: { kind: "sandbox" },',
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      compileAgent({
        startPath: appRoot,
      }),
    ).rejects.toThrow(
      'Expected the agent config export "default" from "agent.mjs" to match the public eve shape.',
    );
  });

  it("rejects the removed experimental.codeMode field", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-experimental-code-mode-",
      APP_ROOT_OPTIONS,
    );

    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "agent.mjs"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        "  experimental: { codeMode: true },",
        "};",
        "",
      ].join("\n"),
    );

    await expect(compileAgent({ startPath: appRoot })).rejects.toThrow("codeMode");
  });

  it("uses the authored local subagent id as the canonical compiled runtime id", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-subagent-id-",
      APP_ROOT_OPTIONS,
    );
    const subagentRoot = join(agentRoot, "subagents", "researcher");

    await mkdir(subagentRoot, {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(join(subagentRoot, "instructions.md"), "Research tasks deeply.");
    await writeFile(
      join(subagentRoot, "agent.mjs"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        '  description: "Investigate one task in depth.",',
        "};",
        "",
      ].join("\n"),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.subagents).toHaveLength(1);
    expect(result.manifest.subagents[0]).toMatchObject({
      sourceId: "subagents/researcher",
    });
    const researcher = result.manifest.subagents[0];
    if (researcher?.configResolver !== undefined) throw new Error("expected a static subagent");
    expect(researcher?.agent.config.name).toBe("researcher");
  });

  it("compiles remote subagents into the owning node manifest", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-remote-subagent-owned-manifest-",
      APP_ROOT_OPTIONS,
    );
    const researcherRoot = join(agentRoot, "subagents", "researcher");

    await mkdir(join(researcherRoot, "subagents"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "subagents", "weather.ts"),
      [
        "export default {",
        '  kind: "remote",',
        '  description: "Answer weather questions remotely.",',
        '  url: () => process.env.WEATHER_AGENT_URL ?? "https://weather.example.com",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(researcherRoot, "agent.mjs"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        '  description: "Investigate one task in depth.",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(researcherRoot, "subagents", "qux.ts"),
      [
        "export default {",
        '  kind: "remote",',
        '  description: "Answer niche follow-up questions remotely.",',
        '  url: "https://qux.example.com",',
        "};",
        "",
      ].join("\n"),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });
    const moduleMapText = await readFile(result.paths.moduleMapPath, "utf8");
    const normalizedModuleMapText = normalizeArtifactValue(moduleMapText.trimEnd(), appRoot);

    expect(result.manifest.remoteAgents).toMatchObject([
      {
        description: "Answer weather questions remotely.",
        logicalPath: "subagents/weather.ts",
        name: "weather",
        nodeId: "subagents/weather.ts",
        path: "/eve/v1/session",
        sourceId: "subagents/weather.ts",
      },
    ]);
    // A function `url` is resolved at runtime, so nothing is baked here.
    expect(result.manifest.remoteAgents[0]).not.toHaveProperty("url");
    expect(result.manifest.subagents).toHaveLength(1);
    expect(result.manifest.subagents[0]?.agent.remoteAgents).toMatchObject([
      {
        description: "Answer niche follow-up questions remotely.",
        logicalPath: "subagents/qux.ts",
        name: "qux",
        nodeId: "subagents/researcher::subagents/qux.ts",
        path: "/eve/v1/session",
        sourceId: "subagents/qux.ts",
        url: "https://qux.example.com",
      },
    ]);
    expect(result.manifest.subagents.map((subagent) => subagent.name)).toEqual(["researcher"]);
    expect(normalizedModuleMapText).toContain('"../../agent/subagents/weather.ts"');
    expect(normalizedModuleMapText).toContain(
      '"../../agent/subagents/researcher/subagents/qux.ts"',
    );
  });

  it("stores resolved sandbox bootstrap revalidation keys in compiled artifacts", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-sandbox-revalidation-key-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "sandbox"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "sandbox", "sandbox.mjs"),
      [
        "export default {",
        "  async revalidationKey() {",
        '    return "bootstrap-revalidation-key-v1";',
        "  },",
        "  async bootstrap({ use }) {",
        "    const sandbox = await use();",
        '    await sandbox.run({ command: "echo bootstrap" });',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.sandbox).toEqual({
      backendName: undefined,
      description: undefined,
      exportName: undefined,
      hasBootstrap: true,
      hasOnSession: false,
      inheritsParent: undefined,
      logicalPath: "sandbox/sandbox.mjs",
      revalidationKey: "bootstrap-revalidation-key-v1",
      sourceHash: expect.any(String),
      sourceId: "sandbox/sandbox.mjs",
      sourceKind: "module",
    });
  });

  it("compiles sandbox bootstrap without a revalidation key", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-sandbox-without-revalidation-key-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "sandbox"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(
      join(agentRoot, "sandbox", "sandbox.mjs"),
      [
        "export default {",
        "  async bootstrap({ use }) {",
        "    const sandbox = await use();",
        '    await sandbox.run({ command: "echo bootstrap" });',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });

    expect(result.manifest.sandbox).toEqual({
      backendName: undefined,
      description: undefined,
      exportName: undefined,
      hasBootstrap: true,
      hasOnSession: false,
      inheritsParent: undefined,
      logicalPath: "sandbox/sandbox.mjs",
      revalidationKey: undefined,
      sourceHash: expect.any(String),
      sourceId: "sandbox/sandbox.mjs",
      sourceKind: "module",
    });
  });

  it("rejects sandbox bootstrap revalidation keys that resolve to empty or non-string values", async () => {
    const emptyKeyApp = await createSandboxRevalidationKeyValidationApp({
      name: "empty",
      revalidationKeyExpression: '() => ""',
    });
    const nonStringKeyApp = await createSandboxRevalidationKeyValidationApp({
      name: "non-string",
      revalidationKeyExpression: "() => 123",
    });

    await expect(compileAgent({ startPath: emptyKeyApp.appRoot })).rejects.toThrow(
      /must return a non-empty string/,
    );
    await expect(compileAgent({ startPath: nonStringKeyApp.appRoot })).rejects.toThrow(
      /must return a string/,
    );
  });

  it("compiles authored subagent sandboxes into child runtime nodes", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-compile-subagent-sandbox-",
      APP_ROOT_OPTIONS,
    );
    const subagentRoot = join(agentRoot, "subagents", "researcher");

    await mkdir(join(subagentRoot, "sandbox"), {
      recursive: true,
    });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.");
    await writeFile(join(subagentRoot, "instructions.md"), "Research tasks deeply.");
    await writeFile(
      join(subagentRoot, "agent.mjs"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        '  description: "Investigate one task in depth.",',
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(subagentRoot, "sandbox", "sandbox.mjs"),
      [
        "export default {",
        "  async onSession({ use }) {",
        "    const sandbox = await use();",
        '    await sandbox.run({ command: "mkdir -p .research" });',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const result = await compileAgent({
      startPath: appRoot,
    });
    const moduleMapText = await readFile(result.paths.moduleMapPath, "utf8");
    const normalizedModuleMapText = normalizeArtifactValue(moduleMapText.trimEnd(), appRoot);

    expect(result.manifest.subagents[0]).toMatchObject({
      agent: {
        sandbox: {
          logicalPath: "sandbox/sandbox.mjs",
          sourceId: "sandbox/sandbox.mjs",
          sourceKind: "module",
        },
      },
      nodeId: "subagents/researcher",
      sourceId: "subagents/researcher",
    });
    expect(normalizedModuleMapText).toContain('"load": () => import("../../agent/agent.mjs")');
    expect(normalizedModuleMapText).toContain("../../agent/subagents/researcher/agent.mjs");
    expect(normalizedModuleMapText).toContain(
      "../../agent/subagents/researcher/sandbox/sandbox.mjs",
    );
    expect(normalizedModuleMapText).toContain('"subagents/researcher": Object.freeze({');
    expect(normalizedModuleMapText).toContain('"sandbox/sandbox.mjs": Object.freeze({');
  });

  it("fails fast on discovery errors after writing inspectable artifacts", async () => {
    const { agentRoot, appRoot } = await createAppRoot("eve-compile-fast-fail-", APP_ROOT_OPTIONS);

    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    // No instructions.md or instructions.ts authored — discovery should fail
    // with DISCOVER_REQUIRED_INSTRUCTIONS_MISSING.

    let thrownError: unknown;

    try {
      await compileAgent({
        startPath: appRoot,
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(CompileAgentError);

    if (!(thrownError instanceof CompileAgentError)) {
      throw new Error("Expected compileAgent to throw a CompileAgentError.");
    }

    const [compiledManifestText, discoveryManifestText, diagnosticsText, metadataText] =
      await Promise.all([
        readFile(thrownError.result.paths.compiledManifestPath, "utf8"),
        readFile(thrownError.result.paths.discoveryManifestPath, "utf8"),
        readFile(thrownError.result.paths.diagnosticsPath, "utf8"),
        readFile(thrownError.result.paths.compileMetadataPath, "utf8"),
      ]);
    const diagnosticsArtifact = JSON.parse(diagnosticsText) as {
      summary: {
        errors: number;
        warnings: number;
      };
    };
    const metadata = JSON.parse(metadataText) as {
      status: string;
    };

    expect(thrownError.message).toContain("Compilation failed with 1 error(s) and 0 warning(s).");
    expect(thrownError.message).toContain(
      `Diagnostics artifact: ${thrownError.result.paths.diagnosticsPath}`,
    );
    expect(thrownError.message).toContain("Compiler diagnostics:");
    expect(thrownError.message).toContain(
      'Expected authored instructions at "instructions.md", "instructions.ts", "instructions.cts", "instructions.mts", "instructions.js", "instructions.cjs", "instructions.mjs", or "instructions/" directory.',
    );
    expect(thrownError.message).toContain(`source: __root__ · ${agentRoot}`);
    expect(thrownError.result.project.agentRoot).toBe(agentRoot);
    expect(thrownError.result.metadata.status).toBe("failed");
    expect(JSON.parse(discoveryManifestText)).toMatchObject({
      kind: "eve-agent-discovery-manifest",
      diagnosticsSummary: {
        errors: 1,
        warnings: 0,
      },
    });
    expect(JSON.parse(compiledManifestText)).toMatchObject({
      kind: "eve-agent-compiled-manifest",
      diagnosticsSummary: {
        errors: 1,
        warnings: 0,
      },
    });
    expect(diagnosticsArtifact.summary).toEqual({
      errors: 1,
      warnings: 0,
    });
    expect(metadata.status).toBe("failed");
  });
});

async function createSandboxRevalidationKeyValidationApp(input: {
  readonly name: string;
  readonly revalidationKeyExpression: string;
}): Promise<{ readonly agentRoot: string; readonly appRoot: string }> {
  const app = await createAppRoot(
    `eve-compile-sandbox-${input.name}-revalidation-key-`,
    APP_ROOT_OPTIONS,
  );

  await mkdir(join(app.agentRoot, "sandbox"), {
    recursive: true,
  });
  await writeFile(
    join(app.agentRoot, "agent.mjs"),
    'export default { model: "openai/gpt-5.4" };\n',
  );
  await writeFile(join(app.agentRoot, "instructions.md"), "You are a precise assistant.");
  await writeFile(
    join(app.agentRoot, "sandbox", "sandbox.mjs"),
    [
      "export default {",
      `  revalidationKey: ${input.revalidationKeyExpression},`,
      "  async bootstrap({ use }) {",
      "    const sandbox = await use();",
      '    await sandbox.run({ command: "echo bootstrap" });',
      "  },",
      "};",
      "",
    ].join("\n"),
  );

  return app;
}

async function expectTscToPass(
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<void> {
  try {
    await runFile(process.execPath, [...args], options);
  } catch (error) {
    if (isCommandError(error)) {
      throw new Error(
        [
          "tsc failed.",
          `stdout:\n${String(error.stdout ?? "")}`,
          `stderr:\n${String(error.stderr ?? "")}`,
        ].join("\n"),
      );
    }

    throw error;
  }
}

function isCommandError(error: unknown): error is Error & {
  readonly stderr?: unknown;
  readonly stdout?: unknown;
} {
  return error instanceof Error;
}

function normalizeArtifactValue<T>(value: T, appRoot: string): T {
  if (typeof value === "string") {
    return value.replaceAll(appRoot, "<app-root>") as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeArtifactValue(entry, appRoot)) as T;
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => {
        if (key === "contentSha256" && typeof entryValue === "string") {
          return [key, "<sha256>"];
        }

        return [key, normalizeArtifactValue(entryValue, appRoot)];
      }),
    ) as T;
  }

  return value;
}

function normalizeCompileMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCompileMetadata(entry));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => {
        if ((key === "sha256" || key === "sourceGraphHash") && typeof entryValue === "string") {
          return [key, "<sha256>"];
        }

        if (
          key === "name" &&
          typeof entryValue === "string" &&
          "version" in value &&
          value.version === resolveInstalledPackageInfo().version &&
          entryValue === resolveInstalledPackageInfo().name
        ) {
          return [key, "<package-name>"];
        }

        if (
          key === "version" &&
          typeof entryValue === "string" &&
          "name" in value &&
          value.name === resolveInstalledPackageInfo().name &&
          entryValue === resolveInstalledPackageInfo().version
        ) {
          return [key, "<package-version>"];
        }

        return [key, normalizeCompileMetadata(entryValue)];
      }),
    );
  }

  return value;
}

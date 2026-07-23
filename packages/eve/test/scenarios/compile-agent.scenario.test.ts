import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  createCompileMetadata,
  resolveCompilerArtifactPaths,
  writeCompilerArtifacts,
} from "../../src/compiler/artifacts.js";
import { CompileAgentError, compileAgent } from "../../src/compiler/compile-agent.js";
import {
  COMPILED_AGENT_MANIFEST_VERSION,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "../../src/compiler/manifest.js";
import { createDiscoverWarningDiagnostic } from "../../src/discover/diagnostics.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "../../src/discover/manifest.js";
import { resolveInstalledPackageInfo } from "../../src/internal/application/package.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import {
  EXTENSION_AGENT_DESCRIPTOR,
  TOOL_OVERRIDES_DESCRIPTOR,
  VERBOSE_BUNDLING_DESCRIPTOR,
} from "../../src/internal/testing/scenario-apps/index.js";
import { defineInstructions } from "../../src/public/instructions/index.js";
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
const DEFAULT_AGENT_MODEL_ID = "anthropic/claude-sonnet-5";

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
    expect(withoutConfig.manifest.config.source).toBeUndefined();

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
        createDiscoverWarningDiagnostic({
          code: "discover/unsupported-directory",
          message: 'Ignoring unsupported directory "drafts/" in the agent root.',
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
      diagnostics: [
        createDiscoverWarningDiagnostic({
          code: "discover/unsupported-directory",
          message: 'Ignoring unsupported directory "drafts/" in the agent root.',
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
      version: 12,
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
      channels: [
        {
          kind: "channel",
          logicalPath: "channels/support.mjs",
          method: "POST",
          name: "support",
          sourceId: "channels/support.mjs",
          sourceKind: "module",
          urlPath: "/support",
        },
        {
          kind: "channel",
          logicalPath: "channels/support.mjs",
          method: "GET",
          name: "support",
          sourceId: "channels/support.mjs",
          sourceKind: "module",
          urlPath: "/support/events",
        },
      ],
      kind: "eve-agent-compiled-manifest",
      instructions: {
        name: "instructions",
        logicalPath: "instructions.md",
        markdown: "You are a precise assistant.",
        sourceId: "instructions.md",
        sourceKind: "markdown",
      },
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
      kind: "eve-discovery-diagnostics",
      summary: {
        errors: 0,
        warnings: 1,
      },
      version: 1,
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
      version: 5,
    });
    expect(moduleMapText).toContain('"nodes": Object.freeze({');
    expect(moduleMapText).toContain(`"${ROOT_COMPILED_AGENT_NODE_ID}": Object.freeze({`);
    expect(moduleMapText).toContain('"agent.mjs": module_0');
    expect(moduleMapText).not.toContain('"subagents": Object.freeze({');
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
      diagnostics: [],
      manifest,
    });
    const moduleMapText = await readFile(writtenArtifacts.paths.moduleMapPath, "utf8");

    const normalizedModuleMapText = normalizeArtifactValue(moduleMapText.trimEnd(), appRoot);

    // Authored instructions modules execute once at build time and are baked into the
    // compiled manifest as markdown. They never appear in the module map.
    expect(normalizedModuleMapText).not.toContain("instructions.mjs");
    expect(normalizedModuleMapText).toContain('import * as module_0 from "../../agent/agent.mjs";');
    expect(normalizedModuleMapText).toContain(
      'import * as module_1 from "../../agent/tools/get_weather.mjs";',
    );
    expect(normalizedModuleMapText).toContain(
      'import * as module_2 from "../../agent/subagents/reviewer/agent.mjs";',
    );
    expect(normalizedModuleMapText).toContain(
      'import * as module_3 from "../../agent/subagents/reviewer/tools/review.mjs";',
    );
    expect(normalizedModuleMapText).toContain('"nodes": Object.freeze({');
    expect(normalizedModuleMapText).toContain(`"${ROOT_COMPILED_AGENT_NODE_ID}": Object.freeze({`);
    expect(normalizedModuleMapText).toContain('"agent.mjs": module_0');
    expect(normalizedModuleMapText).toContain('"tools/get_weather.mjs": module_1');
    expect(normalizedModuleMapText).toContain('"subagents/reviewer": Object.freeze({');
    expect(normalizedModuleMapText).toContain('"agent.mjs": module_2');
    expect(normalizedModuleMapText).toContain('"tools/review.mjs": module_3');
  });

  it("records versioned artifact hashes in compile metadata", () => {
    const appRoot = "/tmp/weather-agent";
    const paths = resolveCompilerArtifactPaths(appRoot);
    const firstMetadata = createCompileMetadata({
      appRoot,
      diagnosticsArtifactJson: '{"kind":"eve-discovery-diagnostics"}\n',
      diagnosticsSummary: {
        errors: 0,
        warnings: 1,
      },
      discoveryManifestJson: '{"kind":"eve-agent-discovery-manifest","agentId":"weather-agent"}\n',
      moduleMapSource: "export const moduleMap = {};\n",
      paths,
    });
    const secondMetadata = createCompileMetadata({
      appRoot,
      diagnosticsArtifactJson: '{"kind":"eve-discovery-diagnostics"}\n',
      diagnosticsSummary: {
        errors: 0,
        warnings: 1,
      },
      discoveryManifestJson:
        '{"kind":"eve-agent-discovery-manifest","agentId":"weather-agent-v2"}\n',
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
  });
});

describe("compileAgent", () => {
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
          formatVersion: 1,
          builtWithEve: "0.0.0-test",
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
    expect(result.manifest.instructions?.markdown).toContain("Prefer the CRM over guessing.");

    const moduleMapText = await readFile(result.paths.moduleMapPath, "utf8");
    expect(moduleMapText).toContain("@acme/crm/extension/tools/crm_search.mjs");
    expect(moduleMapText).toContain('"ext:crm:tools/crm_search.mjs"');
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
    expect(result.manifest.tools).toEqual([
      {
        description:
          "Get weather details using lib extension imports through mixed extension loading across cjs/js/mts/mjs modules.",
        inputSchema: null,
        logicalPath: "tools/get_weather.mts",
        name: "get_weather",
        sourceId: "tools/get_weather.mts",
        sourceKind: "module",
      },
    ]);
    expect(result.manifest.sandbox).toEqual({
      description: undefined,
      exportName: undefined,
      logicalPath: "sandbox/sandbox.cjs",
      revalidationKey: undefined,
      sourceHash: expect.any(String),
      sourceId: "sandbox/sandbox.cjs",
      sourceKind: "module",
    });
    expect(normalizeArtifactValue(moduleMapText, app.appRoot)).toContain('"agent.cjs": module_0');
    expect(normalizeArtifactValue(moduleMapText, app.appRoot)).toContain(
      '"sandbox/sandbox.cjs": module_1',
    );
    expect(normalizeArtifactValue(moduleMapText, app.appRoot)).toContain(
      '"tools/get_weather.mts": module_2',
    );
  });

  it("compiles verbose-bundling fixture tools that import from @/ and @/lib/* aliases", async () => {
    const app = await scenarioApp(VERBOSE_BUNDLING_DESCRIPTOR);
    const toolsRoot = join(app.appRoot, "agent", "tools");

    await rm(join(toolsRoot, "inspect_snowflake_module.ts"), { force: true });

    const result = await compileAgent({
      startPath: app.appRoot,
    });

    expect(result.manifest.tools).toEqual([
      {
        description: "Return alias path markers from @/ and @/lib/ imports.",
        inputSchema: null,
        logicalPath: "tools/check_alias_paths.ts",
        name: "check_alias_paths",
        sourceId: "tools/check_alias_paths.ts",
        sourceKind: "module",
      },
    ]);
  });

  it("compiles a fixture that wraps, disables, and replaces framework tools", async () => {
    const app = await scenarioApp(TOOL_OVERRIDES_DESCRIPTOR);

    const result = await compileAgent({
      startPath: app.appRoot,
    });

    // The disable sentinel reaches the compiled manifest as a name in the
    // dedicated array, not as a tool entry.
    expect([...result.manifest.disabledFrameworkTools].sort()).toEqual([
      "agent",
      "web_fetch",
      "web_search",
    ]);

    // Both the wrapped bash and the replacement todo land in `tools` as
    // ordinary CompiledToolDefinitions. The web_fetch override is intentionally
    // absent — the disable sentinel is partitioned out before this point.
    const toolsByName = new Map(result.manifest.tools.map((tool) => [tool.name, tool]));

    expect([...toolsByName.keys()].sort()).toEqual(["bash", "todo"]);

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

    expect(result.manifest.tools).toEqual([
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
    expect(result.manifest.subagents[0]?.agent.config.name).toBe("researcher");
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
        nodeId: "subagents/qux.ts",
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
      description: undefined,
      exportName: undefined,
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
      description: undefined,
      exportName: undefined,
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
    expect(normalizedModuleMapText).toContain('import * as module_0 from "../../agent/agent.mjs";');
    expect(normalizedModuleMapText).toContain(
      'import * as module_1 from "../../agent/subagents/researcher/agent.mjs";',
    );
    expect(normalizedModuleMapText).toContain(
      'import * as module_2 from "../../agent/subagents/researcher/sandbox/sandbox.mjs";',
    );
    expect(normalizedModuleMapText).toContain('"subagents/researcher": Object.freeze({');
    expect(normalizedModuleMapText).toContain('"sandbox/sandbox.mjs": module_2');
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

    expect(thrownError.message).toContain("Discovery failed with 1 error(s) and 0 warning(s).");
    expect(thrownError.message).toContain(
      `Diagnostics artifact: ${thrownError.result.paths.diagnosticsPath}`,
    );
    expect(thrownError.message).toContain("Discovery diagnostics:");
    expect(thrownError.message).toContain(
      'Expected authored instructions at "instructions.md", "instructions.ts", "instructions.cts", "instructions.mts", "instructions.js", "instructions.cjs", "instructions.mjs", or "instructions/" directory.',
    );
    expect(thrownError.message).toContain(`source: ${agentRoot}`);
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

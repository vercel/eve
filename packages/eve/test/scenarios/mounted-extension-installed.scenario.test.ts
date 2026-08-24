import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
} from "../../src/internal/nitro/host/build-extension.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "../../src/internal/application/runtime-compiled-artifacts-source.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { loadCompiledArtifactSet } from "../../src/runtime/loaders/compiled-artifact-set.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import { loadResolvedModuleExport } from "../../src/runtime/resolve-helpers.js";

const scenarioApp = useScenarioApp();
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })),
  );
});

const PACKAGE_NAME = "@acme/installed-crm";
const EXT_TREE: Readonly<Record<string, string>> = {
  "extension/extension.ts": [
    'import { defineExtension } from "eve/extension";',
    "interface CrmConfig { apiKey: string; }",
    'const config = { "~standard": { version: 1, vendor: "scenario", validate: (value: unknown) => ({ value: value as CrmConfig }), types: undefined as { input: CrmConfig; output: CrmConfig } | undefined } } as const;',
    "export default defineExtension({ config });",
    "",
  ].join("\n"),
  "extension/tools/echo.ts": [
    'import { defineTool } from "eve/tools";',
    'import extension from "../extension.js";',
    "export default defineTool({",
    '  description: "Echo the configured API key.",',
    '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
    "  async execute() {",
    "    return { apiKey: (extension.config as { apiKey: string }).apiKey };",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/tools/shout.ts": [
    'import { defineTool } from "eve/tools";',
    'import extension from "../extension.js";',
    "export default defineTool({",
    '  description: "Shout the configured API key.",',
    '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
    "  async execute() {",
    "    return { apiKey: extension.config.apiKey.toUpperCase() };",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/tools/dynamic.ts": [
    'import { defineDynamic, defineTool } from "eve/tools";',
    'import extension from "../extension.js";',
    "export default defineDynamic({",
    "  events: {",
    '    "session.started": async () => ({',
    "      quote: defineTool({",
    '        description: "Quote the configured API key.",',
    '        inputSchema: { type: "object", properties: {}, additionalProperties: false },',
    "        async execute() { return { apiKey: extension.config.apiKey }; },",
    "      }),",
    "    }),",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/channels/status.ts": [
    'import { defineChannel, GET } from "eve/channels";',
    'import extension from "../extension.js";',
    "export default defineChannel({",
    "  routes: [",
    '    GET("/crm/status", async () => new Response(extension.config.apiKey)),',
    "  ],",
    "});",
    "",
  ].join("\n"),
  "extension/schedules/sync.ts": [
    'import { defineSchedule } from "eve/schedules";',
    'import extension from "../extension.js";',
    "export default defineSchedule({",
    '  cron: "0 9 * * *",',
    "  run({ waitUntil }) {",
    "    waitUntil(Promise.resolve(extension.config.apiKey));",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/subagents/reviewer/agent.ts": [
    'import { defineAgent } from "eve";',
    "export default defineAgent({",
    '  model: "openai/gpt-5.4",',
    '  description: "Review CRM records.",',
    "});",
    "",
  ].join("\n"),
  "extension/subagents/reviewer/tools/key.ts": [
    'import { defineTool } from "eve/tools";',
    'import extension from "../../../extension.js";',
    "export default defineTool({",
    '  description: "Read the configured API key.",',
    '  inputSchema: { type: "object", properties: {}, additionalProperties: false },',
    "  async execute() {",
    "    return { apiKey: extension.config.apiKey };",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/subagents/weather.ts": [
    'import { defineRemoteAgent } from "eve";',
    "export default defineRemoteAgent({",
    '  description: "Answer weather questions.",',
    '  url: "https://weather.example.com",',
    "});",
    "",
  ].join("\n"),
  "extension/skills/notes.ts": [
    'import { defineSkill } from "eve/skills";',
    "export default defineSkill({",
    '  description: "Take structured notes.",',
    '  markdown: "# Notes\\nRecord decisions as bullet points.",',
    "});",
    "",
  ].join("\n"),
  "extension/skills/research.ts": [
    'import { defineSkill } from "eve/skills";',
    "export default defineSkill({",
    '  description: "Research an account.",',
    '  markdown: "# Research\\nUse the checklist.",',
    '  files: { "references/checklist.md": "# Checklist\\n" },',
    "});",
    "",
  ].join("\n"),
  "extension/skills/guide/SKILL.md": [
    "---",
    "description: How to triage with the CRM.",
    "---",
    "",
    "# Guide",
    "",
    "Follow references/steps.md.",
    "",
  ].join("\n"),
  "extension/skills/guide/references/steps.md": "# Steps\n",
  "extension/skills/oncall.ts": [
    'import { defineDynamic, defineSkill } from "eve/skills";',
    "export default defineDynamic({",
    "  events: {",
    '    "session.started": async () => ({',
    "      escalation: defineSkill({",
    '        description: "Escalate an incident.",',
    '        markdown: "# Escalation\\nPage the on-call.",',
    "      }),",
    "    }),",
    "  },",
    "});",
    "",
  ].join("\n"),
  "extension/instructions/policy.md": "Prefer the CRM tools for account questions.\n",
  "extension/instructions/dynamic.ts": [
    'import { defineDynamic, defineInstructions } from "eve/instructions";',
    "export default defineDynamic({",
    "  events: {",
    '    "session.started": async () =>',
    '      defineInstructions({ markdown: "Treat CRM results as authoritative." }),',
    "  },",
    "});",
    "",
  ].join("\n"),
};

/**
 * Builds a TypeScript-authored extension and returns exactly the package's
 * publishable files: package.json plus the complete dist tree. No author source
 * is placed under the consumer's node_modules, so the consumer must discover
 * and normalize the emitted agent-shaped distribution.
 */
async function buildInstalledExtensionFiles(): Promise<Record<string, string>> {
  const extRoot = await mkdtemp(join(tmpdir(), "eve-ext-src-"));
  tempRoots.push(extRoot);
  await writeFile(
    join(extRoot, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        type: "module",
        eve: {
          extension: { source: "./extension", dist: "./dist/extension" },
        },
        peerDependencies: { eve: "*" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await mkdir(join(extRoot, "node_modules"), { recursive: true });
  await symlink(
    dirname(createRequire(import.meta.url).resolve("eve/package.json")),
    join(extRoot, "node_modules", "eve"),
    "dir",
  );
  for (const [path, contents] of Object.entries(EXT_TREE)) {
    await mkdir(dirname(join(extRoot, path)), { recursive: true });
    await writeFile(join(extRoot, path), contents, "utf8");
  }

  const config = await tryReadExtensionBuildConfig(extRoot);
  const outDir = await buildExtensionPackage(extRoot, config!);

  const files: Record<string, string> = {
    [`node_modules/${PACKAGE_NAME}/package.json`]: await readFile(
      join(extRoot, "package.json"),
      "utf8",
    ),
  };
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolutePath = join(entry.parentPath, entry.name);
    const distRelativePath = relative(outDir, absolutePath).replaceAll("\\", "/");
    files[`node_modules/${PACKAGE_NAME}/dist/${distRelativePath}`] = await readFile(
      absolutePath,
      "utf8",
    );
  }
  return files;
}

describe("mounted extension installed under node_modules", () => {
  it("loads every supported contribution form from a dist-only package", async () => {
    const extensionFiles = await buildInstalledExtensionFiles();
    expect(
      Object.keys(extensionFiles).some((path) => path.includes(`${PACKAGE_NAME}/extension/`)),
    ).toBe(false);
    expect(Object.keys(extensionFiles)).toContain(
      `node_modules/${PACKAGE_NAME}/dist/extension/_manifest.json`,
    );
    expect(
      JSON.parse(extensionFiles[`node_modules/${PACKAGE_NAME}/dist/extension/_manifest.json`]!),
    ).toMatchObject({ requires: { channel: 8, schedule: 3, subagent: 2 } });
    const app = await scenarioApp({
      name: "mounted-extension-installed",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/subagents/manager/agent.mjs": [
          "export default {",
          '  model: "openai/gpt-5.4",',
          '  description: "Manage CRM reviews.",',
          "};",
          "",
        ].join("\n"),
        "agent/subagents/manager/extensions/nested.mjs": [
          `import crm from "${PACKAGE_NAME}";`,
          'export default crm({ apiKey: "sk-installed" });',
          "",
        ].join("\n"),
        "agent/extensions/crm.mjs": [
          `import crm from "${PACKAGE_NAME}";`,
          'export default crm({ apiKey: "sk-installed" });',
          "",
        ].join("\n"),
        ...extensionFiles,
      },
    });

    await compileAgent({ startPath: app.appRoot });

    const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(app.appRoot);
    const { manifest, moduleMap } = await loadCompiledArtifactSet({ compiledArtifactsSource });
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    const echo = graph.root.agent.tools.find((entry) => entry.name === "crm__echo");
    expect(echo).toBeDefined();
    await expect(echo?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-installed",
    });

    const shout = graph.root.agent.tools.find((entry) => entry.name === "crm__shout");
    await expect(shout?.execute?.({}, { messages: [], toolCallId: "call_2" })).resolves.toEqual({
      apiKey: "SK-INSTALLED",
    });

    const status = graph.root.agent.channels.find((entry) => entry.name === "crm__status");
    expect(status).toMatchObject({
      method: "GET",
      sourceId: "ext:crm:channels/status.mjs",
      urlPath: "/crm/status",
    });
    if (status === undefined) throw new Error("Expected the extension channel to resolve.");
    if (status.handler === undefined) throw new Error("Expected an HTTP channel handler.");
    const response = await status.handler(
      new Request("https://example.com/crm/status"),
      {} as Parameters<NonNullable<typeof status.handler>>[1],
    );
    await expect(response.text()).resolves.toBe("sk-installed");

    const sync = manifest.schedules.find((entry) => entry.name === "crm__sync");
    expect(sync).toMatchObject({
      cron: "0 9 * * *",
      hasRun: true,
      sourceId: "ext:crm:schedules/sync.mjs",
    });
    if (sync === undefined) throw new Error("Expected the extension schedule to compile.");
    const syncDefinition = (await loadResolvedModuleExport({
      definition: sync,
      kindLabel: "schedule",
      moduleMap,
      nodeId: undefined,
    })) as {
      run(input: { waitUntil(task: Promise<unknown>): void }): Promise<void> | void;
    };
    let scheduledTask: Promise<unknown> | undefined;
    await syncDefinition.run({
      waitUntil(task) {
        scheduledTask = task;
      },
    });
    await expect(scheduledTask).resolves.toBe("sk-installed");

    const reviewer = graph.root.subagentRegistry.subagentsByName.get("crm__reviewer");
    expect(reviewer?.definition).toMatchObject({
      name: "crm__reviewer",
      sourceId: "ext:crm:subagents/reviewer",
    });
    const reviewerNode = graph.nodesByNodeId.get(reviewer!.definition.nodeId);
    const key = reviewerNode?.agent.tools.find((entry) => entry.name === "key");
    await expect(key?.execute?.({}, { messages: [], toolCallId: "call_3" })).resolves.toEqual({
      apiKey: "sk-installed",
    });
    expect(
      graph.root.subagentRegistry.subagentsByName.get("crm__weather")?.definition,
    ).toMatchObject({
      kind: "remote",
      sourceId: "ext:crm:subagents/weather.mjs",
      url: "https://weather.example.com",
    });

    const manager = graph.root.subagentRegistry.subagentsByName.get("manager");
    const managerNode = graph.nodesByNodeId.get(manager!.definition.nodeId);
    const nestedReviewer = managerNode?.subagentRegistry.subagentsByName.get("nested__reviewer");
    const nestedReviewerNode = graph.nodesByNodeId.get(nestedReviewer!.definition.nodeId);
    const nestedKey = nestedReviewerNode?.agent.tools.find((entry) => entry.name === "key");
    await expect(nestedKey?.execute?.({}, { messages: [], toolCallId: "call_4" })).resolves.toEqual(
      { apiKey: "sk-installed" },
    );

    expect(graph.root.agent.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["crm__notes", "crm__research", "crm__guide"]),
    );
    expect(
      graph.root.agent.skills.find((skill) => skill.name === "crm__notes")?.markdown,
    ).toContain("Record decisions as bullet points.");

    const skillsResourceRoot = join(
      app.appRoot,
      ".eve",
      "compile",
      "workspace-resources",
      "__root__",
      "skills",
    );
    await expect(
      readFile(join(skillsResourceRoot, "crm__guide", "references", "steps.md"), "utf8"),
    ).resolves.toBe("# Steps\n");
    await expect(
      readFile(join(skillsResourceRoot, "crm__research", "references", "checklist.md"), "utf8"),
    ).resolves.toBe("# Checklist\n");

    const dynamicTools = graph.root.agent.dynamicToolResolvers.find(
      (resolver) => resolver.slug === "crm__dynamic",
    );
    const producedTools = (await dynamicTools?.events["session.started"]?.({}, {})) as {
      quote: { execute(input: unknown, context: unknown): Promise<unknown> };
    };
    await expect(producedTools.quote.execute({}, {})).resolves.toEqual({ apiKey: "sk-installed" });

    const dynamicSkills = graph.root.agent.dynamicSkillResolvers.find(
      (resolver) => resolver.slug === "crm__oncall",
    );
    const producedSkills = (await dynamicSkills?.events["session.started"]?.({}, {})) as {
      escalation: { markdown: string };
    };
    expect(producedSkills.escalation.markdown).toContain("Page the on-call.");

    const dynamicInstructions = graph.root.agent.dynamicInstructionsResolvers.find(
      (resolver) => resolver.slug === "crm__dynamic",
    );
    const producedInstructions = (await dynamicInstructions?.events["session.started"]?.(
      {},
      {},
    )) as { markdown: string };
    expect(producedInstructions.markdown).toBe("Treat CRM results as authoritative.");
    expect(manifest.instructions.map((entry) => entry.content).join("\n")).toContain(
      "Prefer the CRM tools for account questions.",
    );
  });
});

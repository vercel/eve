import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent, compileAgentInWorkspace } from "#compiler/compile-agent.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { publishDevelopmentGeneration } from "#internal/nitro/development-generation.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type { SandboxProviderPrepareContext } from "#shared/sandbox-provider.js";
import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const createScratchDirectory = useTemporaryDirectories();

describe("prewarmAppSandboxes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads a Dockerfile from the stable authored root for isolated compiler artifacts", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-authored-dockerfile-");
    const agentRoot = join(appRoot, "agent");
    await mkdir(join(agentRoot, "sandbox"), { recursive: true });
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify({ name: "dockerfile-prewarm-test", type: "module" }),
    );
    await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };');
    await writeFile(join(agentRoot, "instructions.md"), "Use the sandbox.");
    await writeFile(join(agentRoot, "sandbox", "Dockerfile"), "FROM alpine:3.21\n");
    await writeFile(
      join(agentRoot, "sandbox", "sandbox.ts"),
      [
        'import { defineSandbox } from "eve/sandbox";',
        'import { MicrosandboxSandbox } from "eve/sandbox/microsandbox";',
        "export const environment = MicrosandboxSandbox.dockerfile();",
        "export default defineSandbox(() => environment.create());",
      ].join("\n"),
    );
    const compilerAppRoot = join(appRoot, ".eve", "builds", "isolated", "compiler");
    await compileAgentInWorkspace({
      artifactLocations: {
        publishedRoot: join(compilerAppRoot, ".eve"),
        writeRoot: join(compilerAppRoot, ".eve"),
      },
      startPath: appRoot,
    });
    const dockerfilePaths: string[] = [];

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(compilerAppRoot, {
        moduleMapLoaderPath: resolvePackageSourceFilePath(
          "src/internal/authored-module-map-loader.ts",
        ),
        sandboxAppRoot: appRoot,
      }),
      dispatch: async ({ context }) => {
        if (context.dockerfile !== undefined) dockerfilePaths.push(context.dockerfile.path);
        return { artifact: { imageReference: "registry.example/eve@sha256:test" }, reused: false };
      },
    });

    expect(dockerfilePaths).toEqual([join(agentRoot, "sandbox", "Dockerfile")]);
    const preparedManifest = JSON.parse(
      await readFile(
        join(compilerAppRoot, ".eve", "compile", "sandbox-prepared-artifacts.json"),
        "utf8",
      ),
    );
    expect(preparedManifest).toMatchObject({
      entries: [
        {
          artifact: { imageReference: "registry.example/eve@sha256:test" },
          providerName: "microsandbox",
          templateName: expect.any(String),
        },
      ],
      kind: "eve-sandbox-prepared-artifacts",
      version: 1,
    });
  });

  it("loads workspace seeds from an invocation-owned compiler directory", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_isolated_build_prewarm");

    const appRoot = await createScenarioAppRoot();
    const compilerAppRoot = join(appRoot, ".eve", "builds", "isolated", "compiler");
    await compileAgentInWorkspace({
      artifactLocations: {
        publishedRoot: join(compilerAppRoot, ".eve"),
        writeRoot: join(compilerAppRoot, ".eve"),
      },
      startPath: appRoot,
    });
    const events = createPrewarmEvents();

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(compilerAppRoot, {
        moduleMapLoaderPath: resolvePackageSourceFilePath(
          "src/internal/authored-module-map-loader.ts",
        ),
        sandboxAppRoot: appRoot,
      }),
      dispatch: createRecordingDispatch(events),
    });

    expect(events.seededTemplateCount).toBe(2);
    expect([...events.seededFilePaths].sort()).toEqual([
      "$HOME/.agents/skills/research/SKILL.md",
      "$HOME/.agents/skills/route-weather/SKILL.md",
    ]);
  });

  it("prewarms the root and subagent sandbox templates with per-agent skill seeds", async () => {
    // Per-sandbox provider resolution falls back to DefaultSandbox.environment() when
    // an authored sandbox does not declare `backend`. Mark this process
    // as running on Vercel so the test sandboxes resolve to a backend
    // whose `prewarm` is called by the orchestrator.
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_execution_seed_prewarm");

    const appRoot = await createScenarioAppRoot();
    const events = createPrewarmEvents();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: createRecordingDispatch(events),
    });

    // Two authored sandboxes (root + subagent), each receiving only
    // the skills authored on that agent.
    expect(events.templateKeys).toHaveLength(2);
    expect(events.seededTemplateCount).toBe(2);
    expect([...events.seededFilePaths].sort()).toEqual([
      "$HOME/.agents/skills/research/SKILL.md",
      "$HOME/.agents/skills/route-weather/SKILL.md",
    ]);
    expect([...events.runPreparationCommands].sort()).toEqual([
      "echo child-bootstrap",
      "echo root-bootstrap",
    ]);
  });

  it("prewarms dev runtime snapshots with per-agent skill seeds", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_execution_dev_seed_prewarm");

    const appRoot = await createScenarioAppRoot();
    const events = createPrewarmEvents();
    const compileResult = await compileAgent({
      startPath: appRoot,
    });
    await publishDevelopmentGeneration(compileResult);

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: resolveNitroCompiledArtifactsSource(
        createDevelopmentNitroArtifactsConfig({ appRoot }),
      ),
      dispatch: createRecordingDispatch(events),
    });

    expect(events.templateKeys).toHaveLength(2);
    expect(new Set(events.runtimeContextAppRoots)).toEqual(new Set([appRoot]));
    expect(events.seededTemplateCount).toBe(2);
    expect([...events.seededFilePaths].sort()).toEqual([
      "$HOME/.agents/skills/research/SKILL.md",
      "$HOME/.agents/skills/route-weather/SKILL.md",
    ]);
  });

  it("skips framework default sandbox templates when nodes have no resources or preparation", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_default_per_node");

    const appRoot = await createDefaultGraphAppRoot();
    const events = createPrewarmEvents();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: createRecordingDispatch(events),
    });

    expect(events.templateKeys).toHaveLength(0);
  });

  it("skips empty default subagent templates when only the root authors a sandbox", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_root_authored_subagent_defaults");

    const appRoot = await createDefaultGraphAppRoot({
      rootSandbox: true,
    });
    const events = createPrewarmEvents();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: createRecordingDispatch(events),
    });

    expect(events.templateKeys).toHaveLength(1);
    expect([...events.runPreparationCommands]).toEqual(["echo root-bootstrap"]);
  });

  it("prewarms one template per node when every node authors a sandbox", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_all_authored_sandboxes");

    const appRoot = await createDefaultGraphAppRoot({
      rootSandbox: true,
      subagentSandboxes: true,
    });
    const events = createPrewarmEvents();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: createRecordingDispatch(events),
    });

    expect(events.templateKeys).toHaveLength(4);
    expect(new Set(events.templateKeys)).toHaveLength(4);
    expect([...events.runPreparationCommands].sort()).toEqual([
      "echo alpha-bootstrap",
      "echo bravo-bootstrap",
      "echo charlie-bootstrap",
      "echo root-bootstrap",
    ]);
  });

  it("skips the single empty root framework default sandbox template", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_single_default_root");

    const appRoot = await createDefaultGraphAppRoot({
      subagentNames: [],
    });
    const events = createPrewarmEvents();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: createRecordingDispatch(events),
    });

    expect(events.templateKeys).toHaveLength(0);
  });

  it("uses skill content to key seed-only sandbox templates across deploy roots", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_seed_only_templates");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_seed_only_one");

    const firstAppRoot = await createSkillOnlyAppRoot({
      skillBody: "Route weather content.",
    });
    const firstEvents = createPrewarmEvents();

    await compileAgent({
      startPath: firstAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: firstAppRoot,
      dispatch: createRecordingDispatch(firstEvents),
    });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_seed_only_two");

    const secondAppRoot = await createSkillOnlyAppRoot({
      skillBody: "Route weather content.",
    });
    const secondEvents = createPrewarmEvents();

    await compileAgent({
      startPath: secondAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: secondAppRoot,
      dispatch: createRecordingDispatch(secondEvents),
    });

    const changedAppRoot = await createSkillOnlyAppRoot({
      skillBody: "Changed route weather content.",
    });
    const changedEvents = createPrewarmEvents();

    await compileAgent({
      startPath: changedAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: changedAppRoot,
      dispatch: createRecordingDispatch(changedEvents),
    });

    expect(firstEvents.templateKeys).toHaveLength(1);
    expect(secondEvents.templateKeys).toEqual(firstEvents.templateKeys);
    expect(changedEvents.templateKeys[0]).not.toBe(firstEvents.templateKeys[0]);
    expect(firstEvents.seededFilePaths).toEqual(["$HOME/.agents/skills/route-weather/SKILL.md"]);
  });

  it("uses compiled environment source revisions across deploy roots without re-executing the selector at prewarm", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap_templates");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_one");

    const firstAppRoot = await createPreparedEnvironmentAppRoot({
      environmentRevision: '() => "bootstrap-revalidation-v1"',
      skillBody: "Route weather content.",
    });
    const firstEvents = createPrewarmEvents();

    await compileAgent({
      startPath: firstAppRoot,
    });
    await writePreparedEnvironmentSandbox({
      appRoot: firstAppRoot,
      environmentRevision: "environment-v1-changed-after-compile",
    });
    await prewarmAppSandboxes({
      appRoot: firstAppRoot,
      dispatch: createRecordingDispatch(firstEvents),
    });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_two");

    const secondAppRoot = await createPreparedEnvironmentAppRoot({
      environmentRevision: '() => "bootstrap-revalidation-v1"',
      skillBody: "Route weather content.",
    });
    const secondEvents = createPrewarmEvents();

    await compileAgent({
      startPath: secondAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: secondAppRoot,
      dispatch: createRecordingDispatch(secondEvents),
    });

    const changedKeyAppRoot = await createPreparedEnvironmentAppRoot({
      environmentRevision: '() => "bootstrap-revalidation-v2"',
      skillBody: "Route weather content.",
    });
    const changedKeyEvents = createPrewarmEvents();

    await compileAgent({
      startPath: changedKeyAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: changedKeyAppRoot,
      dispatch: createRecordingDispatch(changedKeyEvents),
    });

    const changedSeedAppRoot = await createPreparedEnvironmentAppRoot({
      environmentRevision: '() => "bootstrap-revalidation-v1"',
      skillBody: "Changed route weather content.",
    });
    const changedSeedEvents = createPrewarmEvents();

    await compileAgent({
      startPath: changedSeedAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: changedSeedAppRoot,
      dispatch: createRecordingDispatch(changedSeedEvents),
    });

    const changedSourceAppRoot = await createPreparedEnvironmentAppRoot({
      runPreparationCommand: "echo prepared-environment-changed-source",
      environmentRevision: '() => "bootstrap-revalidation-v1"',
      skillBody: "Route weather content.",
    });
    const changedSourceEvents = createPrewarmEvents();

    await compileAgent({
      startPath: changedSourceAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: changedSourceAppRoot,
      dispatch: createRecordingDispatch(changedSourceEvents),
    });

    expect(firstEvents.templateKeys).toHaveLength(1);
    expect(secondEvents.templateKeys).toEqual(firstEvents.templateKeys);
    expect(changedKeyEvents.templateKeys[0]).not.toBe(firstEvents.templateKeys[0]);
    expect(changedSeedEvents.templateKeys[0]).not.toBe(firstEvents.templateKeys[0]);
    expect(changedSourceEvents.templateKeys[0]).not.toBe(firstEvents.templateKeys[0]);
    expect(firstEvents.runPreparationCommands).toEqual(["echo prepared-environment"]);
  });

  it("keeps unseeded prepared templates stable across deploy roots and instruction changes", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap_templates");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_empty_one");

    const firstAppRoot = await createPreparedEnvironmentAppRoot({
      environmentRevision: undefined,
    });
    const firstEvents = createPrewarmEvents();
    const first = await compileAgent({ startPath: firstAppRoot });
    await prewarmAppSandboxes({
      appRoot: firstAppRoot,
      dispatch: createRecordingDispatch(firstEvents),
    });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_empty_two");
    const secondAppRoot = await createPreparedEnvironmentAppRoot({
      environmentRevision: undefined,
    });
    await writeFile(join(secondAppRoot, "agent", "instructions.md"), "Changed system prompt.\n");
    const secondEvents = createPrewarmEvents();
    const second = await compileAgent({ startPath: secondAppRoot });
    await prewarmAppSandboxes({
      appRoot: secondAppRoot,
      dispatch: createRecordingDispatch(secondEvents),
    });

    expect(first.manifest.workspaceResourceRoot.contentHash).toBeUndefined();
    expect(second.manifest.workspaceResourceRoot.contentHash).toBeUndefined();
    expect(second.metadata.discovery.sourceGraphHash).not.toBe(
      first.metadata.discovery.sourceGraphHash,
    );
    expect(firstEvents.templateKeys).toHaveLength(1);
    expect(secondEvents.templateKeys).toEqual(firstEvents.templateKeys);
    expect(firstEvents.seededFilePaths).toEqual([]);
    expect(secondEvents.seededFilePaths).toEqual([]);
  });

  it("uses authored sandbox source when environment source changes", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap_templates");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_no_key_one");

    const firstAppRoot = await createPreparedEnvironmentAppRoot({
      environmentRevision: undefined,
      skillBody: "Route weather content.",
    });
    const firstEvents = createPrewarmEvents();

    await compileAgent({
      startPath: firstAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: firstAppRoot,
      dispatch: createRecordingDispatch(firstEvents),
    });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_no_key_two");

    const secondAppRoot = await createPreparedEnvironmentAppRoot({
      environmentRevision: undefined,
      skillBody: "Route weather content.",
    });
    const secondEvents = createPrewarmEvents();

    await compileAgent({
      startPath: secondAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: secondAppRoot,
      dispatch: createRecordingDispatch(secondEvents),
    });

    const changedSourceAppRoot = await createPreparedEnvironmentAppRoot({
      runPreparationCommand: "echo bootstrap-without-revalidation-key-changed-source",
      environmentRevision: undefined,
      skillBody: "Route weather content.",
    });
    const changedSourceEvents = createPrewarmEvents();

    await compileAgent({
      startPath: changedSourceAppRoot,
    });
    await prewarmAppSandboxes({
      appRoot: changedSourceAppRoot,
      dispatch: createRecordingDispatch(changedSourceEvents),
    });

    expect(firstEvents.templateKeys).toHaveLength(1);
    expect(secondEvents.templateKeys).toEqual(firstEvents.templateKeys);
    expect(changedSourceEvents.templateKeys[0]).not.toBe(firstEvents.templateKeys[0]);
    expect(firstEvents.runPreparationCommands).toEqual(["echo prepared-environment"]);
  });

  it("authored default override produces a single prewarm target, not two", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_authored_default_override");

    const appRoot = await createAuthoredOverrideAppRoot();
    const events = createPrewarmEvents();
    const log = vi.fn();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: createRecordingDispatch(events),
      log,
    });

    // Only one prewarm target for a single-node graph: the root
    // authored default.
    expect(events.templateKeys).toHaveLength(1);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "eve: initializing 1 sandbox template...",
      "eve: initialized 1 sandbox template (0 reused, 1 built).",
    ]);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("framework"));
    expect([...events.runPreparationCommands]).toEqual(["echo default-bootstrap"]);
  });

  it("does not report reused templates in the build log", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_authored_default_reused");

    const appRoot = await createAuthoredOverrideAppRoot();
    const events = createPrewarmEvents();
    const log = vi.fn();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: createRecordingDispatch(events, { reused: true }),
      log,
    });

    expect(events.templateKeys).toHaveLength(1);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("reused cached"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("built sandbox template"));
  });

  it("authored default override receives skill seed files in its single target", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_authored_default_skills");

    const appRoot = await createAuthoredOverrideAppRoot({
      withSkills: true,
    });
    const events = createPrewarmEvents();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: createRecordingDispatch(events),
    });

    // Still only one target — the authored default with skill seeds merged in.
    expect(events.templateKeys).toHaveLength(1);
    expect(events.seededTemplateCount).toBe(1);
    expect([...events.seededFilePaths].sort()).toEqual(
      [
        "$HOME/.agents/skills/route-weather/SKILL.md",
        "$HOME/.agents/skills/route-weather/references/checklist.md",
      ].sort(),
    );
    expect([...events.runPreparationCommands]).toEqual(["echo default-bootstrap"]);
  });
});

function preparedSandboxSource(command: string): string {
  return [
    'import { DefaultSandbox, defineSandbox } from "eve/sandbox";',
    "export const environment = DefaultSandbox.environment({",
    "  prepare: async (sandbox) => {",
    `    await sandbox.run({ command: ${JSON.stringify(command)} });`,
    "  },",
    "});",
    "export default defineSandbox(() => environment.create());",
    "",
  ].join("\n");
}

async function createScenarioAppRoot(): Promise<string> {
  const appRoot = await createScratchDirectory("eve-prewarm-");
  const agentRoot = join(appRoot, "agent");
  const subagentRoot = join(agentRoot, "subagents", "researcher");

  await mkdir(join(agentRoot, "sandbox"), {
    recursive: true,
  });
  await mkdir(join(agentRoot, "skills"), {
    recursive: true,
  });
  await mkdir(join(subagentRoot, "sandbox"), {
    recursive: true,
  });
  await mkdir(join(subagentRoot, "skills"), {
    recursive: true,
  });

  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      {
        name: "execution-sandbox-prewarm-test",
        type: "module",
      },
      null,
      2,
    ),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");
  await writeFile(
    join(agentRoot, "skills", "route-weather.md"),
    ["---", "description: Route weather requests.", "---", "Route weather content."].join("\n"),
  );
  await writeFile(
    join(agentRoot, "sandbox", "sandbox.ts"),
    preparedSandboxSource("echo root-bootstrap"),
  );
  await writeFile(
    join(subagentRoot, "agent.ts"),
    [
      "export default {",
      '  model: "openai/gpt-5.4",',
      '  description: "Research one topic.",',
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(join(subagentRoot, "instructions.md"), "Research system prompt.\n");
  await writeFile(
    join(subagentRoot, "skills", "research.md"),
    ["---", "description: Research requests.", "---", "Research content."].join("\n"),
  );
  await writeFile(
    join(subagentRoot, "sandbox", "sandbox.ts"),
    preparedSandboxSource("echo child-bootstrap"),
  );

  return appRoot;
}

async function createDefaultGraphAppRoot(
  input: {
    readonly rootSandbox?: boolean;
    readonly subagentSandboxes?: boolean;
    readonly subagentNames?: readonly string[];
  } = {},
): Promise<string> {
  const appRoot = await createScratchDirectory("eve-prewarm-graph-");
  const agentRoot = join(appRoot, "agent");
  const subagentNames = input.subagentNames ?? ["alpha", "bravo", "charlie"];

  await mkdir(agentRoot, {
    recursive: true,
  });

  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      {
        name: "execution-sandbox-prewarm-default-graph-test",
        type: "module",
      },
      null,
      2,
    ),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");

  if (input.rootSandbox === true) {
    await mkdir(join(agentRoot, "sandbox"), {
      recursive: true,
    });
    await writeFile(
      join(agentRoot, "sandbox", "sandbox.ts"),
      preparedSandboxSource("echo root-bootstrap"),
    );
  }

  for (const name of subagentNames) {
    const subagentRoot = join(agentRoot, "subagents", name);
    await mkdir(subagentRoot, {
      recursive: true,
    });
    await writeFile(
      join(subagentRoot, "agent.ts"),
      [
        "export default {",
        '  model: "openai/gpt-5.4",',
        `  description: "Handle ${name} tasks.",`,
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(join(subagentRoot, "instructions.md"), `${name} system prompt.\n`);

    if (input.subagentSandboxes === true) {
      await mkdir(join(subagentRoot, "sandbox"), {
        recursive: true,
      });
      await writeFile(
        join(subagentRoot, "sandbox", "sandbox.ts"),
        preparedSandboxSource(`echo ${name}-bootstrap`),
      );
    }
  }

  return appRoot;
}

async function createAuthoredOverrideAppRoot(
  input: { readonly withSkills?: boolean } = {},
): Promise<string> {
  const appRoot = await createScratchDirectory("eve-prewarm-override-");
  const agentRoot = join(appRoot, "agent");

  await mkdir(join(agentRoot, "sandbox"), {
    recursive: true,
  });

  if (input.withSkills) {
    await mkdir(join(agentRoot, "skills"), {
      recursive: true,
    });
  }

  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      {
        name: "execution-sandbox-prewarm-default-override-test",
        type: "module",
      },
      null,
      2,
    ),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");
  await writeFile(
    join(agentRoot, "sandbox", "sandbox.ts"),
    preparedSandboxSource("echo default-bootstrap"),
  );

  if (input.withSkills) {
    await writeFile(
      join(agentRoot, "skills", "route-weather.mjs"),
      [
        "export default {",
        '  description: "Route weather requests.",',
        '  markdown: "Route weather content.",',
        '  files: { "references/checklist.md": "Check the forecast source.\\n" },',
        "};",
        "",
      ].join("\n"),
    );
  }

  return appRoot;
}

async function createSkillOnlyAppRoot(input: { readonly skillBody: string }): Promise<string> {
  const appRoot = await createScratchDirectory("eve-prewarm-skill-only-");
  const agentRoot = join(appRoot, "agent");

  await mkdir(join(agentRoot, "skills"), {
    recursive: true,
  });
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      {
        name: "execution-sandbox-prewarm-skill-only-test",
        type: "module",
      },
      null,
      2,
    ),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");
  await writeFile(
    join(agentRoot, "skills", "route-weather.md"),
    ["---", "description: Route weather requests.", "---", input.skillBody].join("\n"),
  );

  return appRoot;
}

async function createPreparedEnvironmentAppRoot(input: {
  readonly runPreparationCommand?: string;
  readonly environmentRevision: string | undefined;
  readonly skillBody?: string;
}): Promise<string> {
  const appRoot = await createScratchDirectory("eve-prewarm-prepared-environment-");
  const agentRoot = join(appRoot, "agent");

  await mkdir(join(agentRoot, "sandbox"), {
    recursive: true,
  });
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      {
        name: "execution-sandbox-prewarm-prepared-environment-test",
        type: "module",
      },
      null,
      2,
    ),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");
  if (input.skillBody !== undefined) {
    await mkdir(join(agentRoot, "skills"), { recursive: true });
    await writeFile(
      join(agentRoot, "skills", "route-weather.md"),
      ["---", "description: Route weather requests.", "---", input.skillBody].join("\n"),
    );
  }
  await writePreparedEnvironmentSandbox({
    appRoot,
    runPreparationCommand: input.runPreparationCommand,
    environmentRevision: input.environmentRevision,
  });

  return appRoot;
}

async function writePreparedEnvironmentSandbox(input: {
  readonly appRoot: string;
  readonly runPreparationCommand?: string;
  readonly environmentRevision: string | undefined;
}): Promise<void> {
  const runPreparationCommand = input.runPreparationCommand ?? "echo prepared-environment";
  await writeFile(
    join(input.appRoot, "agent", "sandbox", "sandbox.ts"),
    [
      'import { DefaultSandbox, defineSandbox } from "eve/sandbox";',
      `// Environment revision: ${input.environmentRevision ?? "source"}`,
      "export const environment = DefaultSandbox.environment({",
      "  prepare: async (sandbox) => {",
      `    await sandbox.run({ command: ${JSON.stringify(runPreparationCommand)} });`,
      "  },",
      "});",
      "export default defineSandbox(() => environment.create());",
      "",
    ].join("\n"),
  );
}

function createRecordingDispatch(
  events: ReturnType<typeof createPrewarmEvents>,
  options: { readonly reused?: boolean } = {},
) {
  return async ({ context }: { context: SandboxProviderPrepareContext }) => {
    events.templateKeys.push(context.templateName);
    events.runtimeContextAppRoots.push(context.appRoot);

    const resourceFiles = [
      ...(context.resources.workspace?.files.map((file) => ({
        ...file,
        path: `${context.resources.workspace?.targetPath}/${file.relativePath}`,
      })) ?? []),
      ...(context.resources.skills?.files.map((file) => ({
        ...file,
        path: `${context.resources.skills?.targetPath}/${file.relativePath}`,
      })) ?? []),
    ];
    if (resourceFiles.length > 0) {
      events.seededTemplateCount += 1;
      events.seededFilePaths.push(...resourceFiles.map((file) => file.path));
    }

    await context.runPreparation({
      id: "test-prewarm-session",
      async readFile() {
        return null;
      },
      async readBinaryFile() {
        return null;
      },
      async readTextFile() {
        return null;
      },
      async setNetworkPolicy() {},
      async removePath() {},
      resolvePath(path: string) {
        return path;
      },
      async run({ command }: { command: string }) {
        events.runPreparationCommands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      },
      async spawn({ command }: { command: string }) {
        events.runPreparationCommands.push(command);
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          async wait() {
            return { exitCode: 0 };
          },
          async kill() {},
        };
      },
      async writeFile() {},
      async writeBinaryFile() {},
      async writeTextFile() {},
    });

    return { artifact: { templateName: context.templateName }, reused: options.reused ?? false };
  };
}

function createPrewarmEvents() {
  return {
    runPreparationCommands: [] as string[],
    runtimeContextAppRoots: [] as string[],
    seededFilePaths: [] as string[],
    seededTemplateCount: 0,
    templateKeys: [] as string[],
  };
}

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent, compileAgentInWorkspace } from "#compiler/compile-agent.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { publishDevelopmentGeneration } from "#internal/nitro/development-generation.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type {
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
} from "#public/definitions/sandbox-backend.js";
import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const createScratchDirectory = useTemporaryDirectories();

describe("prewarmAppSandboxes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
    // Per-sandbox backend resolution falls back to defaultSandbox() when
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
    expect([...events.bootstrapCommands].sort()).toEqual([
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

  it("skips framework default sandbox templates when nodes have no seeds or bootstrap", async () => {
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
    expect([...events.bootstrapCommands]).toEqual(["echo root-bootstrap"]);
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
    expect([...events.bootstrapCommands].sort()).toEqual([
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

  it("uses compiled bootstrap revalidation keys across deploy roots without re-evaluating at prewarm", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap_templates");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_one");

    const firstAppRoot = await createBootstrapRevalidationKeyAppRoot({
      revalidationKeyExpression: '() => "bootstrap-revalidation-v1"',
      skillBody: "Route weather content.",
    });
    const firstEvents = createPrewarmEvents();

    await compileAgent({
      startPath: firstAppRoot,
    });
    await writeBootstrapRevalidationKeySandbox({
      appRoot: firstAppRoot,
      revalidationKeyExpression:
        '() => { throw new Error("revalidationKey should not run during prewarm"); }',
    });
    await prewarmAppSandboxes({
      appRoot: firstAppRoot,
      dispatch: createRecordingDispatch(firstEvents),
    });

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_two");

    const secondAppRoot = await createBootstrapRevalidationKeyAppRoot({
      revalidationKeyExpression: '() => "bootstrap-revalidation-v1"',
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

    const changedKeyAppRoot = await createBootstrapRevalidationKeyAppRoot({
      revalidationKeyExpression: '() => "bootstrap-revalidation-v2"',
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

    const changedSeedAppRoot = await createBootstrapRevalidationKeyAppRoot({
      revalidationKeyExpression: '() => "bootstrap-revalidation-v1"',
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

    const changedSourceAppRoot = await createBootstrapRevalidationKeyAppRoot({
      bootstrapCommand: "echo bootstrap-revalidation-key-changed-source",
      revalidationKeyExpression: '() => "bootstrap-revalidation-v1"',
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
    expect(firstEvents.bootstrapCommands).toEqual(["echo bootstrap-revalidation-key"]);
  });

  it("uses authored sandbox source when bootstrap omits revalidationKey", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bootstrap_templates");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_bootstrap_no_key_one");

    const firstAppRoot = await createBootstrapRevalidationKeyAppRoot({
      revalidationKeyExpression: undefined,
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

    const secondAppRoot = await createBootstrapRevalidationKeyAppRoot({
      revalidationKeyExpression: undefined,
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

    const changedSourceAppRoot = await createBootstrapRevalidationKeyAppRoot({
      bootstrapCommand: "echo bootstrap-without-revalidation-key-changed-source",
      revalidationKeyExpression: undefined,
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
    expect(firstEvents.bootstrapCommands).toEqual(["echo bootstrap-revalidation-key"]);
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
    expect([...events.bootstrapCommands]).toEqual(["echo default-bootstrap"]);
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
    expect([...events.bootstrapCommands]).toEqual(["echo default-bootstrap"]);
  });
});

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
    [
      "export default {",
      '  revalidationKey: () => "root-bootstrap-v1",',
      "  async bootstrap({ use }) {",
      "    const sandbox = await use();",
      '    await sandbox.run({ command: "echo root-bootstrap" });',
      "  },",
      "  onSession() {",
      '    throw new Error("root onSession should not run during build prewarm");',
      "  },",
      "};",
      "",
    ].join("\n"),
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
    [
      "export default {",
      '  revalidationKey: () => "child-bootstrap-v1",',
      "  async bootstrap({ use }) {",
      "    const sandbox = await use();",
      '    await sandbox.run({ command: "echo child-bootstrap" });',
      "  },",
      "  onSession() {",
      '    throw new Error("child onSession should not run during build prewarm");',
      "  },",
      "};",
      "",
    ].join("\n"),
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
      [
        "export default {",
        '  revalidationKey: () => "root-bootstrap-v1",',
        "  async bootstrap({ use }) {",
        "    const sandbox = await use();",
        '    await sandbox.run({ command: "echo root-bootstrap" });',
        "  },",
        "};",
        "",
      ].join("\n"),
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
        [
          "export default {",
          `  revalidationKey: () => "${name}-bootstrap-v1",`,
          "  async bootstrap({ use }) {",
          "    const sandbox = await use();",
          `    await sandbox.run({ command: "echo ${name}-bootstrap" });`,
          "  },",
          "};",
          "",
        ].join("\n"),
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
    [
      "export default {",
      '  revalidationKey: () => "default-bootstrap-v1",',
      "  async bootstrap({ use }) {",
      "    const sandbox = await use();",
      '    await sandbox.run({ command: "echo default-bootstrap" });',
      "  },",
      "  onSession() {",
      '    throw new Error("onSession should not run during build prewarm");',
      "  },",
      "};",
      "",
    ].join("\n"),
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

async function createBootstrapRevalidationKeyAppRoot(input: {
  readonly bootstrapCommand?: string;
  readonly revalidationKeyExpression: string | undefined;
  readonly skillBody: string;
}): Promise<string> {
  const appRoot = await createScratchDirectory("eve-prewarm-bootstrap-revalidation-key-");
  const agentRoot = join(appRoot, "agent");

  await mkdir(join(agentRoot, "sandbox"), {
    recursive: true,
  });
  await mkdir(join(agentRoot, "skills"), {
    recursive: true,
  });
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      {
        name: "execution-sandbox-prewarm-bootstrap-revalidation-key-test",
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
  await writeBootstrapRevalidationKeySandbox({
    appRoot,
    bootstrapCommand: input.bootstrapCommand,
    revalidationKeyExpression: input.revalidationKeyExpression,
  });

  return appRoot;
}

async function writeBootstrapRevalidationKeySandbox(input: {
  readonly appRoot: string;
  readonly bootstrapCommand?: string;
  readonly revalidationKeyExpression: string | undefined;
}): Promise<void> {
  const bootstrapCommand = input.bootstrapCommand ?? "echo bootstrap-revalidation-key";
  const revalidationKeyLine =
    input.revalidationKeyExpression === undefined
      ? []
      : [`  revalidationKey: ${input.revalidationKeyExpression},`];
  await writeFile(
    join(input.appRoot, "agent", "sandbox", "sandbox.ts"),
    [
      "export default {",
      ...revalidationKeyLine,
      "  async bootstrap({ use }) {",
      "    const sandbox = await use();",
      `    await sandbox.run({ command: ${JSON.stringify(bootstrapCommand)} });`,
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

function createRecordingDispatch(
  events: ReturnType<typeof createPrewarmEvents>,
  options: { readonly reused?: boolean } = {},
) {
  return async ({
    input,
  }: {
    input: SandboxBackendPrewarmInput;
  }): Promise<SandboxBackendPrewarmResult> => {
    events.templateKeys.push(input.templateKey);
    events.runtimeContextAppRoots.push(input.runtimeContext.appRoot);

    const seedFiles = input.seedFiles ?? [];
    if (seedFiles.length > 0) {
      events.seededTemplateCount += 1;
      events.seededFilePaths.push(...seedFiles.map((file) => file.path));
    }

    if (input.bootstrap !== undefined) {
      await input.bootstrap({
        use: async () => ({
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
            events.bootstrapCommands.push(command);
            return {
              exitCode: 0,
              stderr: "",
              stdout: "",
            };
          },
          async spawn({ command }: { command: string }) {
            events.bootstrapCommands.push(command);
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
        }),
      });
    }

    return { reused: options.reused ?? false };
  };
}

function createPrewarmEvents() {
  return {
    bootstrapCommands: [] as string[],
    runtimeContextAppRoots: [] as string[],
    seededFilePaths: [] as string[],
    seededTemplateCount: 0,
    templateKeys: [] as string[],
  };
}

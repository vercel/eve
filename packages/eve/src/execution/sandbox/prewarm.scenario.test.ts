import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgentInWorkspace } from "#compiler/compile-agent.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
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
        "export default defineSandbox(() => environment.open());",
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
        await context.files.read("Dockerfile");
        dockerfilePaths.push(join(agentRoot, "sandbox", "Dockerfile"));
        return { imageReference: "registry.example/eve@sha256:test" };
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
});

function preparedSandboxSource(command: string): string {
  return [
    'import { DefaultSandbox, defineSandbox } from "eve/sandbox";',
    "export const environment = DefaultSandbox.environment({",
    "  prepare: async (sandbox) => {",
    `    await sandbox.run({ command: ${JSON.stringify(command)} });`,
    "  },",
    "});",
    "export default defineSandbox(() => environment.open());",
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
    preparedSandboxSource("echo root-prepare"),
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
    preparedSandboxSource("echo child-prepare"),
  );

  return appRoot;
}

function createRecordingDispatch(events: ReturnType<typeof createPrewarmEvents>) {
  return async ({ context }: { context: SandboxProviderPrepareContext }) => {
    events.templateKeys.push(context.storagePath);
    events.runtimeContextAppRoots.push(context.storagePath);

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

    return { storagePath: context.storagePath };
  };
}

function createPrewarmEvents() {
  return {
    preparationCommands: [] as string[],
    runtimeContextAppRoots: [] as string[],
    seededFilePaths: [] as string[],
    seededTemplateCount: 0,
    templateKeys: [] as string[],
  };
}

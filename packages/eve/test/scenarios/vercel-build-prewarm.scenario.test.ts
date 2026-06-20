import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { prewarmAppSandboxes } from "../../src/execution/sandbox/prewarm.js";
import {
  runVercelBuildPrewarm,
  shouldPrewarmVercelBuild,
} from "../../src/internal/nitro/host/vercel-build-prewarm.js";
import type {
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
} from "../../src/public/definitions/sandbox-backend.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";
import { stubSpawnProcess } from "../_helpers/sandbox-session-stub.js";

const createScratchDirectory = useTemporaryDirectories();

describe("Vercel build-time sandbox prewarm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prewarms root and subagent sandbox templates without running onSession", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test_build_prewarm");

    const appRoot = await createScenarioAppRoot();
    const events = createPrewarmEvents();
    const log = vi.fn();

    await compileAgent({
      startPath: appRoot,
    });
    await prewarmAppSandboxes({
      appRoot,
      log,
      dispatch: createRecordingDispatch(events),
    });

    expect(events.templateKeys).toHaveLength(2);
    expect(events.templateKeys.every((templateKey) => templateKey.startsWith("eve-sbx-tpl-"))).toBe(
      true,
    );
    expect([...events.commands].sort()).toEqual(["echo child-bootstrap", "echo root-bootstrap"]);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "eve: initializing 2 sandbox templates...",
      "eve: initialized 2 sandbox templates (0 reused, 2 built).",
    ]);
  });

  it("fails the hosted build when sandbox bootstrap fails during prewarm", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test_build_prewarm");

    const appRoot = await createScenarioAppRoot();

    await compileAgent({
      startPath: appRoot,
    });

    await expect(
      runVercelBuildPrewarm({
        appRoot,
        dispatch: createFailingBootstrapDispatch(),
      }),
    ).rejects.toThrow("bootstrap command failed");
  });

  it("only enables prewarm when both Vercel env variables are present", () => {
    expect(shouldPrewarmVercelBuild()).toBe(false);

    vi.stubEnv("VERCEL", "1");
    expect(shouldPrewarmVercelBuild()).toBe(false);

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test_build_prewarm");
    expect(shouldPrewarmVercelBuild()).toBe(true);
  });

  it("warns when a Vercel build cannot prewarm sandbox templates", async () => {
    vi.stubEnv("VERCEL", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      runVercelBuildPrewarm({
        appRoot: "/unused",
      }),
    ).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith(
      '[eve] WARNING: Skipped Vercel sandbox template prewarm because VERCEL_DEPLOYMENT_ID is missing. The generated .vercel/output may reference sandbox templates that were not provisioned. Do not deploy it with "vercel deploy --prebuilt"; use "vercel deploy" so Vercel builds from source.',
    );
  });

  it("prewarms sandbox templates with per-agent skill seed files", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test_build_prewarm");

    const appRoot = await createScenarioAppRoot({
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

    expect(events.seededTemplates).toEqual(["default", "default"]);
    expect([...events.writtenFilePaths].sort()).toEqual([
      "/workspace/skills/research/SKILL.md",
      "/workspace/skills/route-weather/SKILL.md",
    ]);
  });
});

async function createScenarioAppRoot(
  input: { readonly withSkills?: boolean } = {},
): Promise<string> {
  const appRoot = await createScratchDirectory("eve-vercel-build-prewarm-");
  const agentRoot = join(appRoot, "agent");
  const subagentRoot = join(agentRoot, "subagents", "researcher");

  await mkdir(join(agentRoot, "sandbox"), {
    recursive: true,
  });
  await mkdir(join(subagentRoot, "sandbox"), {
    recursive: true,
  });
  if (input.withSkills) {
    await mkdir(join(agentRoot, "skills"), {
      recursive: true,
    });
    await mkdir(join(subagentRoot, "skills"), {
      recursive: true,
    });
  }
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      {
        name: "vercel-build-prewarm-test",
        type: "module",
      },
      null,
      2,
    ),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");
  if (input.withSkills) {
    await writeFile(
      join(agentRoot, "skills", "route-weather.md"),
      ["---", "description: Route weather requests.", "---", "Route weather content."].join("\n"),
    );
  }
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
  if (input.withSkills) {
    await writeFile(
      join(subagentRoot, "skills", "research.md"),
      ["---", "description: Research requests.", "---", "Research content."].join("\n"),
    );
  }
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

function createRecordingDispatch(events: ReturnType<typeof createPrewarmEvents>) {
  return async ({
    input,
  }: {
    input: SandboxBackendPrewarmInput;
  }): Promise<SandboxBackendPrewarmResult> => {
    events.templateKeys.push(input.templateKey);

    const seedFiles = input.seedFiles ?? [];
    if (seedFiles.length > 0) {
      events.seededTemplates.push("default");
      events.writtenFilePaths.push(...seedFiles.map((file) => file.path));
    }

    if (input.bootstrap !== undefined) {
      await input.bootstrap({
        use: async () => ({
          id: input.templateKey,
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
            events.commands.push(command);
            return {
              exitCode: 0,
              stderr: "",
              stdout: "",
            };
          },
          async spawn() {
            return stubSpawnProcess();
          },
          async writeFile() {},
          async writeBinaryFile() {},
          async writeTextFile() {},
        }),
      });
    }

    return { reused: false };
  };
}

function createFailingBootstrapDispatch() {
  return async ({
    input,
  }: {
    input: SandboxBackendPrewarmInput;
  }): Promise<SandboxBackendPrewarmResult> => {
    if (input.bootstrap !== undefined) {
      await input.bootstrap({
        use: async () => ({
          id: input.templateKey,
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
          async run() {
            throw new Error("bootstrap command failed");
          },
          async spawn() {
            return stubSpawnProcess();
          },
          async writeFile() {},
          async writeBinaryFile() {},
          async writeTextFile() {},
        }),
      });
    }

    return { reused: false };
  };
}

function createPrewarmEvents() {
  return {
    commands: [] as string[],
    seededTemplates: [] as string[],
    templateKeys: [] as string[],
    writtenFilePaths: [] as string[],
  };
}

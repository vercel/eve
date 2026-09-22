import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { prewarmAppSandboxes } from "../../src/execution/sandbox/prewarm.js";
import { runVercelBuildPrewarm } from "../../src/internal/nitro/host/vercel-build-prewarm.js";
import type { SandboxProviderPrepareContext } from "../../src/shared/sandbox-provider.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("Vercel build-time sandbox prewarm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("skips sandbox prewarm outside a Vercel build", async () => {
    await expect(
      runVercelBuildPrewarm({
        appRoot: "/unused",
      }),
    ).resolves.toBe(false);
  });

  it("rejects Vercel output that requires sandbox templates without an OIDC token", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");

    const appRoot = await createScenarioAppRoot();

    await compileAgent({
      startPath: appRoot,
    });

    await expect(
      runVercelBuildPrewarm({
        appRoot,
      }),
    ).rejects.toThrow(
      "Cannot build deployable Vercel output because this app requires sandbox templates and VERCEL_OIDC_TOKEN is missing. Run `vercel link` and `vercel pull`, then retry `vercel build`. Do not deploy the generated .vercel/output.",
    );
  });

  it("prewarms sandbox templates for a local Vercel build without a deployment id", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createVercelOidcToken("prj_local_build"));

    const appRoot = await createScenarioAppRoot();
    const events = createPrewarmEvents();

    await compileAgent({
      startPath: appRoot,
    });

    await expect(
      runVercelBuildPrewarm({
        appRoot,
        dispatch: createRecordingDispatch(events),
      }),
    ).resolves.toBe(true);
    expect(events.templateKeys).toHaveLength(2);
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
      "$HOME/.agents/skills/research/SKILL.md",
      "$HOME/.agents/skills/route-weather/SKILL.md",
    ]);
  });
});

function createVercelOidcToken(projectId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ owner_id: "team_test", project_id: projectId }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

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
  if (input.withSkills) {
    await writeFile(
      join(subagentRoot, "skills", "research.md"),
      ["---", "description: Research requests.", "---", "Research content."].join("\n"),
    );
  }
  await writeFile(
    join(subagentRoot, "sandbox", "sandbox.ts"),
    preparedSandboxSource("echo child-bootstrap"),
  );

  return appRoot;
}

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

function createRecordingDispatch(events: ReturnType<typeof createPrewarmEvents>) {
  return async ({ context }: { context: SandboxProviderPrepareContext }) => {
    events.templateKeys.push(context.storagePath);
    const files = [
      ...(context.resources.workspace?.files.map((file) => ({
        path: `${context.resources.workspace?.targetPath}/${file.relativePath}`,
      })) ?? []),
      ...(context.resources.skills?.files.map((file) => ({
        path: `${context.resources.skills?.targetPath}/${file.relativePath}`,
      })) ?? []),
    ];
    if (files.length > 0) {
      events.seededTemplates.push("default");
      events.writtenFilePaths.push(...files.map((file) => file.path));
    }

    return { storagePath: context.storagePath };
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

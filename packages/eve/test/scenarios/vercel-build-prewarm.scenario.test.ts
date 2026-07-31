import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { prewarmAppSandboxes } from "../../src/execution/sandbox/prewarm.js";
import { runVercelBuildPrewarm } from "../../src/internal/nitro/host/vercel-build-prewarm.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();
const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("Vercel build-time sandbox prewarm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prewarms root and subagent templates without invoking session definitions", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScenarioAppRoot();
    const templateKeys: string[] = [];
    const log = vi.fn();

    await compileAgent({ startPath: appRoot });
    await prewarmAppSandboxes({
      appRoot,
      dispatch: async ({ prewarm, templateKey }) => {
        templateKeys.push(templateKey);
        return await prewarm();
      },
      log,
    });

    expect(templateKeys).toHaveLength(2);
    expect(templateKeys.every((key) => key.startsWith("eve-sbx-tpl-"))).toBe(true);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "eve: initializing 2 sandbox templates...",
      "eve: initialized 2 sandbox templates.",
    ]);
  });

  it("fails the hosted build when provider prewarm fails", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createVercelOidcToken("prj_hosted_build"));
    const appRoot = await createScenarioAppRoot();
    await compileAgent({ startPath: appRoot });

    await expect(
      runVercelBuildPrewarm({
        appRoot,
        dispatch: async () => {
          throw new Error("provider prewarm failed");
        },
      }),
    ).rejects.toThrow("provider prewarm failed");
  });

  it("skips sandbox prewarm outside a Vercel build", async () => {
    await expect(
      runVercelBuildPrewarm({
        appRoot: "/unused",
      }),
    ).resolves.toBe(false);
  });

  it("lets provider templates define their own hosted-build credential requirements", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const appRoot = await createScenarioAppRoot();
    await compileAgent({ startPath: appRoot });

    await expect(runVercelBuildPrewarm({ appRoot })).resolves.toBe(true);
  });

  it("allows a Vercel build without OIDC when no template is required", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const appRoot = await createTemplateFreeScenarioAppRoot();
    await compileAgent({ startPath: appRoot });

    await expect(runVercelBuildPrewarm({ appRoot })).resolves.toBe(true);
  });

  it("prewarms a local Vercel build without a deployment id", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createVercelOidcToken("prj_local_build"));
    const appRoot = await createScenarioAppRoot();
    const templateKeys: string[] = [];
    await compileAgent({ startPath: appRoot });

    await expect(
      runVercelBuildPrewarm({
        appRoot,
        dispatch: async ({ prewarm, templateKey }) => {
          templateKeys.push(templateKey);
          return await prewarm();
        },
      }),
    ).resolves.toBe(true);
    expect(templateKeys).toHaveLength(2);
  });
});

function createVercelOidcToken(projectId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ owner_id: "team_test", project_id: projectId }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

async function createTemplateFreeScenarioAppRoot(): Promise<string> {
  const appRoot = await createScratchDirectory("eve-vercel-build-without-prewarm-");
  const agentRoot = join(appRoot, "agent");
  await mkdir(agentRoot, { recursive: true });
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify({ name: "vercel-build-without-prewarm", type: "module" }),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");
  return appRoot;
}

async function createScenarioAppRoot(): Promise<string> {
  const appRoot = await createScratchDirectory("eve-vercel-build-prewarm-");
  const agentRoot = join(appRoot, "agent");
  const subagentRoot = join(agentRoot, "subagents", "researcher");
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await symlink(EVE_PACKAGE_ROOT, join(appRoot, "node_modules", "eve"), "dir");
  await mkdir(join(agentRoot, "sandbox"), { recursive: true });
  await mkdir(join(subagentRoot, "sandbox"), { recursive: true });
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify({ name: "vercel-build-prewarm-test", type: "module" }),
  );
  await writeFile(join(agentRoot, "agent.ts"), 'export default { model: "openai/gpt-5.4" };\n');
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");
  await writeFile(join(agentRoot, "sandbox", "sandbox.ts"), sandboxModule("root"));
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
  await writeFile(join(subagentRoot, "sandbox", "sandbox.ts"), sandboxModule("child"));
  return appRoot;
}

function sandboxModule(name: string): string {
  return [
    'import { defineSandbox } from "eve/sandbox";',
    'import { defineSandboxTemplate } from "eve/sandbox/provider";',
    "export const template = defineSandboxTemplate({",
    '  type: "test.dev/vercel-build-template/v1",',
    `  async prewarm() { return { snapshotId: ${JSON.stringify(name)} }; },`,
    '  async create() { throw new Error("runtime only"); },',
    "});",
    "export default defineSandbox(() => {",
    '  throw new Error("session definition must not run during build");',
    "});",
    "",
  ].join("\n");
}

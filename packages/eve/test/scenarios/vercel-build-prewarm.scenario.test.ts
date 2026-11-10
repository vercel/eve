import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { prewarmAppSandboxes } from "../../src/execution/sandbox/prewarm.js";
import { runVercelBuildPrewarm } from "../../src/internal/nitro/host/vercel-build-prewarm.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "../../src/runtime/graph.js";
import { populatedPaths } from "../../src/internal/testing/sandbox-provider-harness.js";
import type { SandboxPrepareContext } from "../../src/sandbox/provider.js";
import type { SandboxPreparedArtifactEntry } from "../../src/shared/sandbox-prepared-artifacts.js";
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

  it("rejects Vercel output whose sandbox templates need preparation without an OIDC token", async () => {
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
      "Cannot build deployable Vercel output because this app's sandbox templates need preparation and VERCEL_OIDC_TOKEN is missing. Run `vercel link` and `vercel pull`, then retry `vercel build`. Do not deploy the generated .vercel/output.",
    );
  });

  it("prepares empty sandbox templates without an OIDC token", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");

    const appRoot = await createScenarioAppRoot({ withSandbox: false });
    const entries: SandboxPreparedArtifactEntry[] = [];

    await compileAgent({
      startPath: appRoot,
    });

    await expect(
      runVercelBuildPrewarm({
        appRoot,
        preparedArtifactStore: {
          async write(input) {
            entries.push(...input.entries);
          },
        },
      }),
    ).resolves.toBe(true);
    expect(entries).toEqual([
      {
        artifact: { artifact: {}, provider: "vercel" },
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
        providerName: "default",
      },
    ]);
  });

  it("rejects source snapshots without an OIDC token before contacting Vercel", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const appRoot = await createScenarioAppRoot({ withSandbox: false });
    await writeFile(
      join(appRoot, "agent", "sandbox.ts"),
      [
        'import { defineSandbox } from "eve/sandbox";',
        'import { VercelSandbox } from "eve/sandbox/vercel";',
        "export const environment = VercelSandbox.environment({",
        '  source: { type: "snapshot", snapshotId: "snap_source" },',
        '  token: "test-token", teamId: "team_test", projectId: "prj_test",',
        "  fetch: (...args) => globalThis.fetch(...args),",
        "});",
        "export default defineSandbox(() => environment.open());",
      ].join("\n"),
    );
    await compileAgent({ startPath: appRoot });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected Vercel request"));
    const write = vi.fn();

    await expect(
      runVercelBuildPrewarm({
        appRoot,
        preparedArtifactStore: { write },
      }),
    ).rejects.toThrow("VERCEL_OIDC_TOKEN is missing");
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves unrelated empty-template provider errors without an OIDC token", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const appRoot = await createScenarioAppRoot({ withSandbox: false });
    await writeFile(
      join(appRoot, "agent", "sandbox.ts"),
      [
        'import { defineSandbox } from "eve/sandbox";',
        'import { defineSandboxProvider } from "eve/sandbox/provider";',
        "const provider = defineSandboxProvider({",
        '  name: "custom",',
        "  environment: () => ({",
        '    async prepare() { throw new Error("Custom provider API unavailable; retry later."); },',
        '    async start() { throw new Error("Unused"); },',
        '    async resume() { throw new Error("Unused"); },',
        "    async onSessionEnd() {},",
        "  }),",
        "});",
        "export const environment = provider.environment();",
        "export default defineSandbox(() => environment.open());",
      ].join("\n"),
    );
    await compileAgent({ startPath: appRoot });
    const log = vi.fn();

    await expect(runVercelBuildPrewarm({ appRoot, log })).rejects.toThrow(
      "Custom provider API unavailable; retry later.",
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Custom provider API unavailable; retry later."),
    );
    expect(log.mock.calls.flat().join("\n")).not.toContain("VERCEL_OIDC_TOKEN is missing");
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
      "/home/agent/.agents/skills/research/SKILL.md",
      "/home/agent/.agents/skills/route-weather/SKILL.md",
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
  input: { readonly withSandbox?: boolean; readonly withSkills?: boolean } = {},
): Promise<string> {
  const appRoot = await createScratchDirectory("eve-vercel-build-prewarm-");
  const agentRoot = join(appRoot, "agent");
  const subagentRoot = join(agentRoot, "subagents", "researcher");

  await mkdir(agentRoot, { recursive: true });
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
  await writeFile(
    join(agentRoot, "agent.ts"),
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
  );
  await writeFile(join(agentRoot, "instructions.md"), "Root system prompt.\n");
  if (input.withSandbox === false) return appRoot;
  await mkdir(join(agentRoot, "sandbox"), { recursive: true });
  await mkdir(join(subagentRoot, "sandbox"), { recursive: true });
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
      'import { defineAgent } from "eve";',
      "export default defineAgent({",
      '  model: "openai/gpt-5.4",',
      '  description: "Research one topic.",',
      "});",
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
  return async ({ context }: { context: SandboxPrepareContext }) => {
    events.templateKeys.push(context.storagePath);
    const paths = await populatedPaths(context);
    if (paths.length > 0) {
      events.seededTemplates.push("default");
      events.writtenFilePaths.push(...paths);
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

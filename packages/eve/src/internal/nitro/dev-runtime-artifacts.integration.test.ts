import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { createCompiledAgentManifest, ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { createCompiledModuleMapSource } from "#compiler/module-map.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { publishDevelopmentGeneration } from "#internal/nitro/development-generation.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshot,
  activateDevelopmentRuntimeArtifactsSnapshotTransaction,
  pruneDevelopmentRuntimeArtifactsSnapshots,
  readDevelopmentRuntimeArtifactsSnapshotRoot,
  readDevelopmentRuntimeArtifactsRevision,
  resolveDevelopmentRuntimeArtifactsPointerPath,
  stageDevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";

const createScratchDirectory = useTemporaryDirectories();

async function createNextStyleImportSnapshotFixture(): Promise<{ readonly appRoot: string }> {
  const appRoot = await createScratchDirectory("eve-dev-runtime-next-imports-");
  const agentRoot = join(appRoot, "agent");
  const compileDirectoryPath = join(appRoot, ".eve", "compile");
  const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");
  const moduleMapPath = join(compileDirectoryPath, "module-map.mjs");

  await mkdir(agentRoot, { recursive: true });
  await mkdir(join(appRoot, "src", "features", "editor", "eve"), { recursive: true });
  await mkdir(compileDirectoryPath, { recursive: true });
  await writeFile(join(appRoot, "package.json"), '{"name":"next-agent","type":"module"}\n');
  await writeFile(
    join(appRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["./src/*"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentRoot, "agent.ts"),
    [
      'import { createEveModelRouter } from "./model-router";',
      'import { authSessionAuth } from "@/features/editor/eve/auth-session";',
      "",
      "export const routed = createEveModelRouter(authSessionAuth);",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(agentRoot, "model-router.ts"),
    [
      "export function createEveModelRouter(auth: string) {",
      "  return `router:${auth}`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(appRoot, "src", "features", "editor", "eve", "auth-session.ts"),
    'export const authSessionAuth = "session-auth";\n',
  );

  const manifest = createCompiledAgentManifest({
    agentRoot,
    appRoot,
    config: {
      model: {
        id: "openai/gpt-5.4-mini",
        routing: {
          kind: "gateway",
          target: "openai/gpt-5.4-mini",
        },
      },
      name: "Next Imports Agent",
      source: {
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
        sourceKind: "module",
      },
    },
    instructions: {
      logicalPath: "instructions.md",
      markdown: "Use the routed model.",
      name: "instructions",
      sourceId: "instructions.md",
      sourceKind: "markdown",
    },
  });

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    moduleMapPath,
    createCompiledModuleMapSource({
      manifest,
      moduleMapPath,
    }),
  );

  await publishDevelopmentGeneration({
    paths: { compileDirectoryPath },
    project: { appRoot },
  } as CompileAgentResult);

  return { appRoot };
}

describe("development runtime artifact snapshots", () => {
  it("stages snapshots without moving the latest runtime pointer", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-stage-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(compileDirectoryPath, "compiled-agent-manifest.json"),
      `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`,
    );

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    expect(
      readDevelopmentRuntimeArtifactsSnapshotRoot(
        resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
      ),
    ).toBeUndefined();
    expect(readDevelopmentRuntimeArtifactsRevision(appRoot)).toEqual({
      revision: appRoot,
    });
    expect(
      JSON.parse(await readFile(join(snapshot.snapshotRoot, "generation.json"), "utf8")),
    ).toEqual({ runtimeAppRoot: snapshot.runtimeAppRoot });

    await activateDevelopmentRuntimeArtifactsSnapshot({ appRoot, snapshot });

    expect(readDevelopmentRuntimeArtifactsRevision(appRoot)).toEqual({
      revision: snapshot.runtimeAppRoot,
    });
  });

  it("restores the prior runtime pointer when activation is rolled back", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-activation-rollback-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    await mkdir(agentRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(compileDirectoryPath, "compiled-agent-manifest.json"),
      `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`,
    );
    const compileResult = {
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult;
    const first = await stageDevelopmentRuntimeArtifactsSnapshot(compileResult);
    const second = await stageDevelopmentRuntimeArtifactsSnapshot(compileResult);
    await activateDevelopmentRuntimeArtifactsSnapshot({ appRoot, snapshot: first });

    const activation = await activateDevelopmentRuntimeArtifactsSnapshotTransaction({
      appRoot,
      snapshot: second,
    });
    expect(readDevelopmentRuntimeArtifactsRevision(appRoot).revision).toBe(second.runtimeAppRoot);
    await activation.rollback();

    expect(readDevelopmentRuntimeArtifactsRevision(appRoot).revision).toBe(first.runtimeAppRoot);
    expect(existsSync(join(second.snapshotRoot, "activated"))).toBe(false);
  });

  it("stages package-less flat markdown agents with generated runtime package metadata", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-flat-package-less-");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");

    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(compileDirectoryPath, "compiled-agent-manifest.json"),
      `${JSON.stringify({ agentRoot: appRoot, appRoot }, null, 2)}\n`,
    );

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    await expect(readFile(join(snapshot.runtimeAppRoot, "instructions.md"), "utf8")).resolves.toBe(
      "You are a precise assistant.\n",
    );
    await expect(
      readFile(join(snapshot.runtimeAppRoot, "package.json"), "utf8").then(
        (source) => JSON.parse(source) as Record<string, unknown>,
      ),
    ).resolves.toEqual({
      private: true,
      type: "module",
    });
  });

  it("excludes generated output and dependency directories from source snapshots", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-generated-output-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(appRoot, "node_modules", "heavy-package"), { recursive: true });
    await mkdir(join(appRoot, ".next", "cache"), { recursive: true });
    await mkdir(join(appRoot, ".generated", "compiled"), { recursive: true });
    await mkdir(join(appRoot, "build"), { recursive: true });
    await mkdir(join(appRoot, "dist"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, ".env"), "SECRET=default\n");
    await writeFile(join(appRoot, ".env.local"), "SECRET=local\n");
    await writeFile(join(appRoot, ".env.example"), "SECRET=example\n");
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(join(appRoot, "node_modules", "heavy-package", "index.js"), "export {}\n");
    await writeFile(join(appRoot, ".next", "cache", "webpack.bin"), "cache\n");
    await writeFile(join(appRoot, ".generated", "compiled", "bundle.js"), "generated\n");
    await writeFile(join(appRoot, "build", "server.js"), "build\n");
    await writeFile(join(appRoot, "dist", "index.js"), "dist\n");
    await writeFile(manifestPath, `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`);

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    expect(existsSync(join(snapshot.runtimeAppRoot, "agent", "agent.ts"))).toBe(true);
    expect(existsSync(join(snapshot.runtimeAppRoot, "node_modules"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".env"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".env.local"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".env.example"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".next"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".generated"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, "build"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, "dist"))).toBe(false);
  });

  it("stops copying at nested git repository boundaries", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-nested-git-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const worktreeRoot = join(appRoot, ".claude", "worktrees", "review");
    const nestedRepositoryRoot = join(appRoot, "vendor", "nested-repository");
    const regularDirectoryRoot = join(appRoot, "vendor", "regular-directory");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    await mkdir(join(nestedRepositoryRoot, ".git"), { recursive: true });
    await mkdir(regularDirectoryRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(join(appRoot, ".claude", "notes.md"), "keep this file\n");
    await writeFile(join(worktreeRoot, ".git"), "gitdir: ../../../../.git/worktrees/review\n");
    await writeFile(join(worktreeRoot, "duplicate.ts"), "export const duplicate = true;\n");
    await writeFile(join(nestedRepositoryRoot, "duplicate.ts"), "export const duplicate = true;\n");
    await writeFile(join(regularDirectoryRoot, "source.ts"), "export const copied = true;\n");
    await writeFile(
      join(compileDirectoryPath, "compiled-agent-manifest.json"),
      `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`,
    );

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    expect(existsSync(join(snapshot.runtimeAppRoot, "agent", "agent.ts"))).toBe(true);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".claude", "notes.md"))).toBe(true);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".claude", "worktrees", "review"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, "vendor", "nested-repository"))).toBe(false);
    expect(
      existsSync(join(snapshot.runtimeAppRoot, "vendor", "regular-directory", "source.ts")),
    ).toBe(true);
  });

  it("prunes stale snapshots while preserving the active and recent snapshots", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-prune-");
    const snapshotsRoot = join(appRoot, ".eve", "dev-runtime", "snapshots");
    const activeSnapshotRoot = join(snapshotsRoot, "active");
    const recentSnapshotRoot = join(snapshotsRoot, "recent");
    const retainedSnapshotRoot = join(snapshotsRoot, "retained");
    const staleSnapshotRoot = join(snapshotsRoot, "stale");
    const oldActiveTime = new Date(1_000);
    const now = 1_000_000;

    for (const snapshotRoot of [
      activeSnapshotRoot,
      recentSnapshotRoot,
      retainedSnapshotRoot,
      staleSnapshotRoot,
    ]) {
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(join(snapshotRoot, "marker.txt"), snapshotRoot);
    }
    await utimes(activeSnapshotRoot, oldActiveTime, oldActiveTime);
    await utimes(recentSnapshotRoot, new Date(now - 1_000), new Date(now - 1_000));
    await utimes(retainedSnapshotRoot, new Date(now - 20_000), new Date(now - 20_000));
    await utimes(staleSnapshotRoot, new Date(now - 30_000), new Date(now - 30_000));

    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot,
      snapshot: {
        runtimeAppRoot: join(activeSnapshotRoot, "source", "app"),
        snapshotRoot: activeSnapshotRoot,
        snapshotSourceRoot: join(activeSnapshotRoot, "source"),
        sourceRoot: appRoot,
      },
    });
    await utimes(activeSnapshotRoot, oldActiveTime, oldActiveTime);

    await pruneDevelopmentRuntimeArtifactsSnapshots({
      appRoot,
      gracePeriodMs: 5_000,
      now,
      retainCount: 2,
    });

    await expect(readdir(snapshotsRoot)).resolves.toEqual(
      expect.arrayContaining(["active", "recent", "retained"]),
    );
    expect(existsSync(staleSnapshotRoot)).toBe(false);
  });

  it("records when the active generation is superseded", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-activated-retention-");
    const snapshotsRoot = join(appRoot, ".eve", "dev-runtime", "snapshots");
    const firstSnapshotRoot = join(snapshotsRoot, "first");
    const nextSnapshotRoot = join(snapshotsRoot, "next");

    for (const snapshotRoot of [firstSnapshotRoot, nextSnapshotRoot]) {
      await mkdir(snapshotRoot, { recursive: true });
    }
    const createSnapshot = (snapshotRoot: string) => ({
      runtimeAppRoot: join(snapshotRoot, "source"),
      snapshotRoot,
      snapshotSourceRoot: join(snapshotRoot, "source"),
      sourceRoot: appRoot,
    });
    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot,
      snapshot: createSnapshot(firstSnapshotRoot),
    });
    const beforeRetirement = Date.now();
    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot,
      snapshot: createSnapshot(nextSnapshotRoot),
    });
    const afterRetirement = Date.now();

    const retirement = JSON.parse(
      await readFile(join(firstSnapshotRoot, "retired.json"), "utf8"),
    ) as { retiredAt: number };
    expect(retirement.retiredAt).toBeGreaterThanOrEqual(beforeRetirement);
    expect(retirement.retiredAt).toBeLessThanOrEqual(afterRetirement);
    expect(existsSync(join(nextSnapshotRoot, "retired.json"))).toBe(false);
  });

  it("retains the active, five newest retired, and recently retired generations", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-retired-pruning-");
    const snapshotsRoot = join(appRoot, ".eve", "dev-runtime", "snapshots");
    const activeSnapshotRoot = join(snapshotsRoot, "active");
    const withinGraceSnapshotRoot = join(snapshotsRoot, "within-grace");
    const expiredSnapshotRoots = Array.from({ length: 6 }, (_, index) =>
      join(snapshotsRoot, `expired-${String(index)}`),
    );
    const now = 10_000_000;
    const gracePeriodMs = 30 * 60 * 1_000;

    for (const snapshotRoot of [
      activeSnapshotRoot,
      withinGraceSnapshotRoot,
      ...expiredSnapshotRoots,
    ]) {
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(join(snapshotRoot, "activated"), "");
    }
    await writeFile(
      join(withinGraceSnapshotRoot, "retired.json"),
      `${JSON.stringify({ retiredAt: now - gracePeriodMs + 1 })}\n`,
    );
    for (const [index, snapshotRoot] of expiredSnapshotRoots.entries()) {
      await writeFile(
        join(snapshotRoot, "retired.json"),
        `${JSON.stringify({ retiredAt: now - gracePeriodMs - index - 1 })}\n`,
      );
    }
    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot,
      snapshot: {
        runtimeAppRoot: join(activeSnapshotRoot, "source"),
        snapshotRoot: activeSnapshotRoot,
        snapshotSourceRoot: join(activeSnapshotRoot, "source"),
        sourceRoot: appRoot,
      },
    });

    await pruneDevelopmentRuntimeArtifactsSnapshots({
      appRoot,
      now,
    });

    expect(existsSync(activeSnapshotRoot)).toBe(true);
    expect(existsSync(withinGraceSnapshotRoot)).toBe(true);
    for (const snapshotRoot of expiredSnapshotRoots.slice(0, 4)) {
      expect(existsSync(snapshotRoot)).toBe(true);
    }
    for (const snapshotRoot of expiredSnapshotRoots.slice(4)) {
      expect(existsSync(snapshotRoot)).toBe(false);
    }
  });

  it("starts a full grace period for an activated generation from an older format", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-legacy-retirement-");
    const snapshotsRoot = join(appRoot, ".eve", "dev-runtime", "snapshots");
    const activeSnapshotRoot = join(snapshotsRoot, "active");
    const legacySnapshotRoot = join(snapshotsRoot, "legacy");
    const now = 1_000_000;

    for (const snapshotRoot of [activeSnapshotRoot, legacySnapshotRoot]) {
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(join(snapshotRoot, "activated"), "");
    }
    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot,
      snapshot: {
        runtimeAppRoot: join(activeSnapshotRoot, "source", "app"),
        snapshotRoot: activeSnapshotRoot,
        snapshotSourceRoot: join(activeSnapshotRoot, "source"),
        sourceRoot: appRoot,
      },
    });
    await pruneDevelopmentRuntimeArtifactsSnapshots({
      appRoot,
      gracePeriodMs: 100,
      now,
      retainCount: 0,
    });

    expect(existsSync(legacySnapshotRoot)).toBe(true);
    await expect(readFile(join(legacySnapshotRoot, "retired.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({ retiredAt: now })}\n`,
    );

    await pruneDevelopmentRuntimeArtifactsSnapshots({
      appRoot,
      gracePeriodMs: 100,
      now: now + 101,
      retainCount: 0,
    });
    expect(existsSync(activeSnapshotRoot)).toBe(true);
    expect(existsSync(legacySnapshotRoot)).toBe(false);
  });

  it("applies retirement policy without inspecting local Workflow storage", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-world-independent-pruning-");
    const snapshotsRoot = join(appRoot, ".eve", "dev-runtime", "snapshots");
    const activeSnapshotRoot = join(snapshotsRoot, "active");
    const retiredSnapshotRoot = join(snapshotsRoot, "retired");

    for (const snapshotRoot of [activeSnapshotRoot, retiredSnapshotRoot]) {
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(join(snapshotRoot, "activated"), "");
    }
    await writeFile(
      join(retiredSnapshotRoot, "retired.json"),
      `${JSON.stringify({ retiredAt: 1 })}\n`,
    );
    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot,
      snapshot: {
        runtimeAppRoot: join(activeSnapshotRoot, "source"),
        snapshotRoot: activeSnapshotRoot,
        snapshotSourceRoot: join(activeSnapshotRoot, "source"),
        sourceRoot: appRoot,
      },
    });
    const runsDirectory = join(resolveLocalWorkflowWorldDataDirectory(appRoot), "default", "runs");
    await mkdir(runsDirectory, { recursive: true });
    await writeFile(
      join(runsDirectory, "active-turn.json"),
      `${JSON.stringify({ snapshotRoot: retiredSnapshotRoot, status: "running" })}\n`,
    );

    await pruneDevelopmentRuntimeArtifactsSnapshots({
      appRoot,
      gracePeriodMs: 0,
      now: 2,
      retainCount: 0,
    });

    expect(existsSync(activeSnapshotRoot)).toBe(true);
    expect(existsSync(retiredSnapshotRoot)).toBe(false);
  });

  it("removes a partially staged snapshot when staging fails", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-failed-stage-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      manifestPath,
      `${JSON.stringify({ agentRoot: "/outside-app", appRoot }, null, 2)}\n`,
    );

    await expect(
      stageDevelopmentRuntimeArtifactsSnapshot({
        paths: { compileDirectoryPath },
        project: { appRoot },
      } as CompileAgentResult),
    ).rejects.toThrow("outside runtime app root");

    await expect(readdir(join(appRoot, ".eve", "dev-runtime", "snapshots"))).resolves.toEqual([]);
  });

  it("freezes authored source and rewrites runtime manifest roots for new sessions", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const toolPath = join(agentRoot, "tools", "get_weather.ts");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(join(agentRoot, "tools"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(toolPath, "export const temperature = 72;\n");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          agentRoot,
          appRoot,
          subagents: [
            {
              agent: {
                agentRoot: join(agentRoot, "subagents", "forecast"),
                appRoot,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);
    await activateDevelopmentRuntimeArtifactsSnapshot({ appRoot, snapshot });

    await writeFile(toolPath, "export const temperature = 73;\n");

    expect(
      readDevelopmentRuntimeArtifactsSnapshotRoot(
        resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
      ),
    ).toBe(snapshot.runtimeAppRoot);
    await expect(
      readFile(resolveDevelopmentRuntimeArtifactsPointerPath(appRoot), "utf8").then(
        (source) => JSON.parse(source) as Record<string, unknown>,
      ),
    ).resolves.toMatchObject({
      appRoot,
      kind: "eve-dev-runtime-artifacts-pointer",
      runtimeAppRoot: snapshot.runtimeAppRoot,
      snapshotRoot: snapshot.snapshotRoot,
      version: 2,
    });
    expect(
      resolveNitroCompiledArtifactsSource({
        appRoot,
        devRuntimeArtifactsPointerPath: resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
        kind: "development",
        moduleMapLoaderPath: "/package/src/internal/authored-module-map-loader.ts",
      }),
    ).toMatchObject({
      appRoot: snapshot.runtimeAppRoot,
      kind: "disk",
    });
    await expect(
      readFile(join(snapshot.runtimeAppRoot, "agent", "tools", "get_weather.ts"), "utf8"),
    ).resolves.toBe("export const temperature = 72;\n");
    await expect(
      readFile(
        join(snapshot.runtimeAppRoot, ".eve", "compile", "compiled-agent-manifest.json"),
        "utf8",
      ),
    ).resolves.toContain(JSON.stringify(join(snapshot.runtimeAppRoot, "agent")));
  });

  it("hydrates Next-style agent imports from dev runtime snapshots", async () => {
    const { appRoot } = await createNextStyleImportSnapshotFixture();

    await withRuntimeSession(createRuntimeSession("next-imports-regression"), async () => {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: resolveNitroCompiledArtifactsSource(
          createDevelopmentNitroArtifactsConfig({ appRoot }),
        ),
      });
      const agentModule = bundle.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules["agent.ts"];

      expect(agentModule).toMatchObject({
        routed: "router:session-auth",
      });
    });
  });

  it("hydrates Next-style agent imports when dev snapshot artifacts are loaded from disk", async () => {
    const { appRoot } = await createNextStyleImportSnapshotFixture();
    const runtimeAppRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(
      resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
    );

    expect(runtimeAppRoot).toBeDefined();

    await withRuntimeSession(createRuntimeSession("next-imports-direct-disk-repro"), async () => {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(runtimeAppRoot!),
      });
      const agentModule = bundle.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules["agent.ts"];

      expect(agentModule).toMatchObject({
        routed: "router:session-auth",
      });
    });
  });

  it("keeps compatibility with v1 dev runtime pointers", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-artifacts-pointer-v1-");
    const runtimeAppRoot = join(appRoot, ".eve", "dev-runtime", "snapshots", "legacy");
    const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(appRoot);

    await mkdir(join(appRoot, ".eve", "dev-runtime"), { recursive: true });
    await writeFile(
      pointerPath,
      `${JSON.stringify(
        {
          appRoot: runtimeAppRoot,
          kind: "eve-dev-runtime-artifacts-pointer",
          version: 1,
        },
        null,
        2,
      )}\n`,
    );

    expect(readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath)).toBe(runtimeAppRoot);
  });

  it("preserves workspace-relative tsconfig extends in runtime snapshots", async () => {
    const workspaceRoot = await createScratchDirectory("eve-dev-runtime-workspace-");
    const appRoot = join(workspaceRoot, "agents", "d0");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(workspaceRoot, "agents", "unused"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - agents/*\n");
    await writeFile(join(workspaceRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(workspaceRoot, "tsconfig.base.json"),
      '{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }\n',
    );
    await writeFile(join(workspaceRoot, "agents", "unused", "package.json"), '{"name":"unused"}\n');
    await writeFile(join(appRoot, "package.json"), '{"name":"d0-agent","type":"module"}\n');
    await writeFile(
      join(appRoot, "tsconfig.json"),
      '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "target": "ES2024" } }\n',
    );
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(manifestPath, `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`);

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    expect(snapshot.runtimeAppRoot).toBe(join(snapshot.snapshotSourceRoot, "agents", "d0"));
    await expect(
      readFile(join(snapshot.snapshotSourceRoot, "tsconfig.base.json"), "utf8"),
    ).resolves.toContain('"module"');
    expect(existsSync(join(snapshot.snapshotSourceRoot, "agents", "unused"))).toBe(false);

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(snapshot.runtimeAppRoot, "agent", "agent.ts"),
    );

    expect(moduleNamespace.answer).toBe(42);
  });

  it("freezes local workspace packages resolved through app node_modules symlinks", async () => {
    const workspaceRoot = await createScratchDirectory("eve-dev-runtime-linked-package-");
    const appRoot = join(workspaceRoot, "apps", "agent-app");
    const agentRoot = join(appRoot, "agent");
    const packageRoot = join(workspaceRoot, "packages", "message");
    const externalPackageRoot = join(workspaceRoot, "node_modules", "external-message");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await mkdir(join(packageRoot, "build"), { recursive: true });
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(packageRoot, "node_modules"), { recursive: true });
    await mkdir(externalPackageRoot, { recursive: true });
    await mkdir(join(workspaceRoot, "packages", "unused"), { recursive: true });
    await mkdir(join(appRoot, "node_modules", "@repo"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(
      join(workspaceRoot, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - packages/*\n",
    );
    await writeFile(join(workspaceRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@repo/message": "workspace:*",
          },
          name: "agent-app",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(appRoot, "tsconfig.json"),
      '{ "compilerOptions": { "target": "ES2024" } }\n',
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "external-message": "1.0.0",
          },
          exports: "./dist/index.js",
          name: "@repo/message",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(externalPackageRoot, "package.json"),
      JSON.stringify(
        {
          exports: "./index.js",
          name: "external-message",
          type: "module",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(externalPackageRoot, "index.js"),
      'export const externalMessage = "external";\n',
    );
    await writeFile(
      join(packageRoot, "src", "index.ts"),
      'export const sourceMessage = "snapshotted-source";\n',
    );
    await writeFile(join(packageRoot, "build", "artifact.js"), "build output\n");
    await writeFile(
      join(packageRoot, "dist", "index.js"),
      'import { externalMessage } from "external-message";\nexport const message = `snapshotted:${externalMessage}`;\n',
    );
    await writeFile(
      join(workspaceRoot, "packages", "unused", "package.json"),
      '{"name":"unused"}\n',
    );
    await symlink(packageRoot, join(appRoot, "node_modules", "@repo", "message"), "junction");
    await symlink(
      externalPackageRoot,
      join(packageRoot, "node_modules", "external-message"),
      "junction",
    );
    await writeFile(
      join(agentRoot, "agent.ts"),
      'import { message } from "@repo/message";\nexport const result = message;\n',
    );
    await writeFile(manifestPath, `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`);

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    await writeFile(join(packageRoot, "dist", "index.js"), 'export const message = "live";\n');

    expect(existsSync(join(snapshot.snapshotSourceRoot, "packages", "message"))).toBe(true);
    expect(existsSync(join(snapshot.snapshotSourceRoot, "packages", "message", "build"))).toBe(
      true,
    );
    expect(existsSync(join(snapshot.snapshotSourceRoot, "packages", "message", "dist"))).toBe(true);
    expect(existsSync(join(snapshot.snapshotSourceRoot, "packages", "unused"))).toBe(false);
    await expect(
      lstat(
        join(
          snapshot.snapshotSourceRoot,
          "packages",
          "message",
          "node_modules",
          "external-message",
        ),
      ).then((stats) => stats.isSymbolicLink()),
    ).resolves.toBe(true);

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(snapshot.runtimeAppRoot, "agent", "agent.ts"),
    );

    expect(moduleNamespace.result).toBe("snapshotted:external");
  });
});

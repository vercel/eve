import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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
    await mkdir(join(appRoot, ".devtools"), { recursive: true });
    await mkdir(join(appRoot, "node_modules", "heavy-package"), { recursive: true });
    await mkdir(join(appRoot, ".next", "cache"), { recursive: true });
    await mkdir(join(appRoot, ".generated", "compiled"), { recursive: true });
    await mkdir(join(appRoot, ".workflow-data", "streams"), { recursive: true });
    await mkdir(join(appRoot, ".workflow-vitest"), { recursive: true });
    await mkdir(join(appRoot, "build"), { recursive: true });
    await mkdir(join(appRoot, "dist"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(join(appRoot, ".env"), "SECRET=default\n");
    await writeFile(join(appRoot, ".env.local"), "SECRET=local\n");
    await writeFile(join(appRoot, ".env.example"), "SECRET=example\n");
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(join(appRoot, ".devtools", "generations.json"), "{}\n");
    await writeFile(join(appRoot, "node_modules", "heavy-package", "index.js"), "export {}\n");
    await writeFile(join(appRoot, ".next", "cache", "webpack.bin"), "cache\n");
    await writeFile(join(appRoot, ".generated", "compiled", "bundle.js"), "generated\n");
    await writeFile(join(appRoot, ".workflow-data", "streams", "events.bin"), "events\n");
    await writeFile(join(appRoot, ".workflow-vitest", "steps.mjs"), "export {}\n");
    await writeFile(join(appRoot, "build", "server.js"), "build\n");
    await writeFile(join(appRoot, "dist", "index.js"), "dist\n");
    await writeFile(manifestPath, `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`);

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    expect(existsSync(join(snapshot.runtimeAppRoot, "agent", "agent.ts"))).toBe(true);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".devtools"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, "node_modules"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".env"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".env.local"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".env.example"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".next"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".generated"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".workflow-data"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, ".workflow-vitest"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, "build"))).toBe(false);
    expect(existsSync(join(snapshot.runtimeAppRoot, "dist"))).toBe(false);
  });

  it("mounts declared physical dependency directories into source snapshots", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-physical-dependency-");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const installedPackageRoot = join(appRoot, "node_modules", "@acme", "extension");
    const undeclaredPackageRoot = join(appRoot, "node_modules", "undeclared-package");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(installedPackageRoot, { recursive: true });
    await mkdir(undeclaredPackageRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify({
        dependencies: { "@acme/extension": "1.0.0" },
        type: "module",
      })}\n`,
    );
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(
      join(installedPackageRoot, "package.json"),
      '{"name":"@acme/extension","version":"1.0.0"}\n',
    );
    await writeFile(join(undeclaredPackageRoot, "package.json"), '{"name":"undeclared-package"}\n');
    await writeFile(
      join(compileDirectoryPath, "compiled-agent-manifest.json"),
      `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`,
    );

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);
    const snapshotPackageRoot = join(snapshot.runtimeAppRoot, "node_modules", "@acme", "extension");

    await expect(lstat(snapshotPackageRoot).then((stats) => stats.isSymbolicLink())).resolves.toBe(
      true,
    );
    await expect(realpath(snapshotPackageRoot)).resolves.toBe(await realpath(installedPackageRoot));
    expect(existsSync(join(snapshot.runtimeAppRoot, "node_modules", "undeclared-package"))).toBe(
      false,
    );
  });

  // https://github.com/vercel/eve/issues/1151 — hoisting-workspace expression.
  it("mounts declared dependencies hoisted above the app root into source snapshots", async () => {
    const workspaceRoot = await createScratchDirectory("eve-dev-runtime-hoisted-dependency-");
    const appRoot = join(workspaceRoot, "agents", "support");
    const agentRoot = join(appRoot, "agent");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const hoistedPackageRoot = join(workspaceRoot, "node_modules", "@acme", "extension");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(hoistedPackageRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      '{"private":true,"workspaces":["agents/*"]}\n',
    );
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify({
        dependencies: { "@acme/extension": "1.0.0" },
        type: "module",
      })}\n`,
    );
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(
      join(hoistedPackageRoot, "package.json"),
      '{"name":"@acme/extension","version":"1.0.0"}\n',
    );
    await writeFile(
      join(compileDirectoryPath, "compiled-agent-manifest.json"),
      `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`,
    );

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    // The compiled module map imports the dependency relative to the app's
    // compile directory, escaping the app root toward the install location
    // (`../../../../node_modules/@acme/extension/...`). Any correct snapshot
    // must materialize the package somewhere inside the snapshot where that
    // resolution can land: either mirroring the hoisted location relative to
    // the snapshot source root, or flattened into the app root's own
    // node_modules.
    const acceptableMountLocations = [
      join(snapshot.runtimeAppRoot, "node_modules", "@acme", "extension"),
      join(snapshot.runtimeAppRoot, "..", "..", "node_modules", "@acme", "extension"),
    ];
    expect(acceptableMountLocations.some((location) => existsSync(location))).toBe(true);
  });

  // https://github.com/vercel/eve/issues/1151 — withEve bare-agent-dir expression:
  // the agent root has no package.json of its own; the host app owns the
  // dependency declaration and the install.
  it("mounts host-declared dependencies for bare agent roots without a package.json", async () => {
    const hostRoot = await createScratchDirectory("eve-dev-runtime-bare-agent-dependency-");
    const appRoot = join(hostRoot, "agents", "research");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const hostPackageRoot = join(hostRoot, "node_modules", "@acme", "extension");

    await mkdir(appRoot, { recursive: true });
    await mkdir(hostPackageRoot, { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    // The host boundary is a real workspace root marker so the snapshot's
    // source-root walk resolves to it, exactly like a withEve app.
    await writeFile(join(hostRoot, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(
      join(hostRoot, "package.json"),
      `${JSON.stringify({
        dependencies: { "@acme/extension": "1.0.0" },
        type: "module",
      })}\n`,
    );
    await writeFile(join(appRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(
      join(hostPackageRoot, "package.json"),
      '{"name":"@acme/extension","version":"1.0.0"}\n',
    );
    await writeFile(
      join(compileDirectoryPath, "compiled-agent-manifest.json"),
      `${JSON.stringify({ agentRoot: appRoot, appRoot }, null, 2)}\n`,
    );

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    const acceptableMountLocations = [
      join(snapshot.runtimeAppRoot, "node_modules", "@acme", "extension"),
      join(snapshot.runtimeAppRoot, "..", "..", "node_modules", "@acme", "extension"),
    ];
    expect(acceptableMountLocations.some((location) => existsSync(location))).toBe(true);
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

  it("mounts local workspace packages resolved through app node_modules symlinks in place", async () => {
    const workspaceRoot = await createScratchDirectory("eve-dev-runtime-linked-package-");
    const appRoot = join(workspaceRoot, "apps", "agent-app");
    const agentRoot = join(appRoot, "agent");
    const packageRoot = join(workspaceRoot, "packages", "message");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(packageRoot, "dist"), { recursive: true });
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
          exports: "./dist/index.js",
          name: "@repo/message",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(packageRoot, "dist", "index.js"),
      'export const message = "snapshotted";\n',
    );
    await writeFile(
      join(workspaceRoot, "packages", "unused", "package.json"),
      '{"name":"unused"}\n',
    );
    await symlink(packageRoot, join(appRoot, "node_modules", "@repo", "message"), "junction");
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

    // Workspace dependency packages are mounted in place like installed
    // dependencies instead of being copied into the snapshot.
    expect(existsSync(join(snapshot.snapshotSourceRoot, "packages"))).toBe(false);
    const snapshotMountPath = join(snapshot.runtimeAppRoot, "node_modules", "@repo", "message");
    await expect(lstat(snapshotMountPath).then((stats) => stats.isSymbolicLink())).resolves.toBe(
      true,
    );
    await expect(realpath(snapshotMountPath)).resolves.toBe(await realpath(packageRoot));

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(snapshot.runtimeAppRoot, "agent", "agent.ts"),
    );

    expect(moduleNamespace.result).toBe("live");
  });

  it("freezes workspace packages that host extension mount roots", async () => {
    const workspaceRoot = await createScratchDirectory("eve-dev-runtime-extension-package-");
    const appRoot = join(workspaceRoot, "apps", "agent-app");
    const agentRoot = join(appRoot, "agent");
    const packageRoot = join(workspaceRoot, "packages", "acme-extension");
    const extensionRoot = join(packageRoot, "extension");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(extensionRoot, "tools"), { recursive: true });
    await mkdir(join(appRoot, "node_modules", "@acme"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    await writeFile(
      join(workspaceRoot, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - packages/*\n",
    );
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@acme/extension": "workspace:*",
          },
          name: "agent-app",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(
        {
          exports: "./extension/extension.mjs",
          name: "@acme/extension",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(join(extensionRoot, "extension.mjs"), "export default {};\n");
    await writeFile(
      join(extensionRoot, "tools", "read_label.mjs"),
      'export default { execute: () => "original" };\n',
    );
    await symlink(packageRoot, join(appRoot, "node_modules", "@acme", "extension"), "junction");
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(manifestPath, `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`);

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      manifest: {
        agentRoot,
        appRoot,
        extensionMounts: [{ sourceRoot: extensionRoot }],
      },
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    await writeFile(
      join(extensionRoot, "tools", "read_label.mjs"),
      'export default { execute: () => "live" };\n',
    );

    // Extension mount roots host runtime-hydrated authored source, so the
    // package stays a real copy and the mount links into the snapshot.
    expect(existsSync(join(snapshot.snapshotSourceRoot, "packages", "acme-extension"))).toBe(true);
    await expect(
      readFile(
        join(
          snapshot.snapshotSourceRoot,
          "packages",
          "acme-extension",
          "extension",
          "tools",
          "read_label.mjs",
        ),
        "utf8",
      ),
    ).resolves.toContain("original");
    const snapshotMountPath = join(snapshot.runtimeAppRoot, "node_modules", "@acme", "extension");
    const canonicalSnapshotSourceRoot = await realpath(snapshot.snapshotSourceRoot);
    await expect(realpath(snapshotMountPath)).resolves.toBe(
      join(canonicalSnapshotSourceRoot, "packages", "acme-extension"),
    );
  });

  it("mounts dependencies of workspace packages nested inside the app root", async () => {
    const appRoot = await createScratchDirectory("eve-dev-runtime-nested-workspace-");
    const agentRoot = join(appRoot, "agent");
    const packageRoot = join(appRoot, "packages", "nested");
    const installedPackageRoot = join(packageRoot, "node_modules", "external-value");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    const manifestPath = join(compileDirectoryPath, "compiled-agent-manifest.json");

    await mkdir(agentRoot, { recursive: true });
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(installedPackageRoot, { recursive: true });
    await mkdir(join(appRoot, "node_modules", "@repo"), { recursive: true });
    await mkdir(compileDirectoryPath, { recursive: true });
    // The app root is also the workspace root, so workspace packages live
    // inside the copied app tree.
    await writeFile(join(appRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@repo/nested": "workspace:*",
          },
          name: "agent-app",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "external-value": "1.0.0",
          },
          exports: "./dist/index.js",
          name: "@repo/nested",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(installedPackageRoot, "package.json"),
      '{"name":"external-value","version":"1.0.0","type":"module","exports":"./index.js"}\n',
    );
    await writeFile(join(installedPackageRoot, "index.js"), 'export const value = "nested";\n');
    await writeFile(
      join(packageRoot, "dist", "index.js"),
      'import { value } from "external-value";\nexport const message = value;\n',
    );
    await symlink(packageRoot, join(appRoot, "node_modules", "@repo", "nested"), "junction");
    await writeFile(join(agentRoot, "agent.ts"), "export const answer = 42;\n");
    await writeFile(manifestPath, `${JSON.stringify({ agentRoot, appRoot }, null, 2)}\n`);

    const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot({
      paths: { compileDirectoryPath },
      project: { appRoot },
    } as CompileAgentResult);

    // A copied workspace package keeps the dependency mounts its snapshot
    // copy resolves through.
    expect(
      existsSync(join(snapshot.snapshotSourceRoot, "packages", "nested", "dist", "index.js")),
    ).toBe(true);
    const nestedDependencyMount = join(
      snapshot.snapshotSourceRoot,
      "packages",
      "nested",
      "node_modules",
      "external-value",
    );
    await expect(
      lstat(nestedDependencyMount).then((stats) => stats.isSymbolicLink()),
    ).resolves.toBe(true);
    await expect(realpath(nestedDependencyMount)).resolves.toBe(
      await realpath(installedPackageRoot),
    );

    const moduleNamespace = await loadAuthoredModuleNamespace(
      join(snapshot.snapshotSourceRoot, "packages", "nested", "dist", "index.js"),
    );

    expect(moduleNamespace.message).toBe("nested");
  });
});

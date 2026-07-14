import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveOutputDirectory } from "#internal/application/paths.js";
import { VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH } from "#internal/vercel-agent-summary.js";

export interface ApplicationBuildWorkspace {
  readonly appRoot: string;
  readonly compiler: {
    readonly artifactsDir: string;
    readonly rootDir: string;
  };
  readonly host: {
    readonly artifactsDir: string;
  };
  readonly nitro: {
    readonly buildDir: string;
    readonly surfaceOutputDir: string;
  };
  readonly publication: {
    readonly output: {
      readonly finalDir: string;
      readonly stagedDir: string;
    };
    readonly summary: {
      readonly finalPath: string;
      readonly stagedPath: string;
    };
  };
  readonly rootDir: string;
  readonly workflow: {
    readonly buildDir: string;
  };
}

/**
 * Creates the invocation-owned directory tree under `.eve/builds/<id>` that
 * one production build compiles, bundles, and stages into. Every path a
 * build touches lives here until publication renames the staged output into
 * place, so concurrent builds and a running dev server never interfere.
 */
export async function createApplicationBuildWorkspace(
  appRoot: string,
  outputDirectory?: string,
): Promise<ApplicationBuildWorkspace> {
  const resolvedAppRoot = resolve(appRoot);
  const buildId = `${Date.now().toString(36)}-${randomUUID()}`;
  const rootDir = join(resolvedAppRoot, ".eve", "builds", buildId);
  const compilerRootDir = join(rootDir, "compiler");
  const workspace: ApplicationBuildWorkspace = {
    appRoot: resolvedAppRoot,
    compiler: {
      artifactsDir: join(compilerRootDir, ".eve"),
      rootDir: compilerRootDir,
    },
    host: {
      artifactsDir: join(rootDir, "host"),
    },
    nitro: {
      buildDir: join(rootDir, "nitro"),
      surfaceOutputDir: join(rootDir, "nitro-output"),
    },
    publication: {
      output: {
        finalDir: outputDirectory ?? resolveOutputDirectory(resolvedAppRoot),
        stagedDir: join(rootDir, "output"),
      },
      summary: {
        finalPath: join(resolvedAppRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH),
        stagedPath: join(rootDir, "agent-summary.json"),
      },
    },
    rootDir,
    workflow: {
      buildDir: join(rootDir, "workflow"),
    },
  };

  await mkdir(rootDir, { recursive: true });
  return workspace;
}

export async function removeApplicationBuildWorkspace(
  workspace: ApplicationBuildWorkspace,
): Promise<void> {
  await rm(workspace.rootDir, { force: true, recursive: true });
}

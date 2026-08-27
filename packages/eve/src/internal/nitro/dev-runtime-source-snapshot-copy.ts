import { constants as fsConstants, existsSync } from "node:fs";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DevelopmentRuntimeSourceSnapshotError,
  type DevelopmentSourceSnapshotPlan,
  toDevelopmentSourceSnapshotPath,
} from "#internal/nitro/dev-runtime-source-snapshot.js";

const SNAPSHOT_COPY_MODE = fsConstants.COPYFILE_FICLONE;

export async function copyDevelopmentSourceSnapshot(
  plan: DevelopmentSourceSnapshotPlan,
): Promise<void> {
  await mkdir(plan.snapshotSourceRoot, { recursive: true });

  for (const sourcePath of plan.copyFiles) {
    if (!existsSync(sourcePath)) {
      continue;
    }

    const targetPath = toSnapshotPathForPlan(plan, sourcePath);
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await cp(sourcePath, targetPath, { mode: SNAPSHOT_COPY_MODE, recursive: true });
    } catch (error) {
      throw new DevelopmentRuntimeSourceSnapshotError(
        `Failed to copy development runtime source snapshot path "${sourcePath}" to "${targetPath}": ${formatErrorMessage(error)}`,
      );
    }
  }

  await createSnapshotDependencyMounts(plan);
  await ensureRuntimePackageJson(plan);
}

async function createSnapshotDependencyMounts(plan: DevelopmentSourceSnapshotPlan): Promise<void> {
  for (const dependencyMount of plan.dependencyMounts) {
    const snapshotMountPath = toSnapshotPathForPlan(plan, dependencyMount.mountPath);

    await mkdir(dirname(snapshotMountPath), { recursive: true });
    await symlink(dependencyMount.sourcePath, snapshotMountPath, "junction");
  }
}

async function ensureRuntimePackageJson(plan: DevelopmentSourceSnapshotPlan): Promise<void> {
  const runtimePackageJsonPath = join(plan.runtimeAppRoot, "package.json");

  if (existsSync(runtimePackageJsonPath)) {
    return;
  }

  await mkdir(plan.runtimeAppRoot, { recursive: true });
  await writeFile(
    runtimePackageJsonPath,
    `${JSON.stringify(
      {
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
}

function toSnapshotPathForPlan(plan: DevelopmentSourceSnapshotPlan, sourcePath: string): string {
  return toDevelopmentSourceSnapshotPath({
    snapshotSourceRoot: plan.snapshotSourceRoot,
    sourcePath,
    sourceRoot: plan.sourceRoot,
  });
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

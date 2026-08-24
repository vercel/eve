import { cp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  assertCompiledWorkflowWorldPlanIntegrity,
  type CompiledHostModuleWorkflowWorldPlan,
  type CompiledWorkflowWorldPlan,
  WORKFLOW_WORLD_IGNORED_PACKAGE_PATH_SEGMENTS,
} from "#compiler/workflow-world-plan.js";
import { isErrnoCode } from "#shared/guards.js";

/**
 * Copies a selected custom World graph into an invocation-owned immutable
 * backing. The returned plan keeps the compiler identity while replacing all
 * physical paths with the materialized copies.
 */
export async function materializeCompiledWorkflowWorldPlan(input: {
  readonly destinationRoot: string;
  readonly plan: CompiledWorkflowWorldPlan;
}): Promise<CompiledWorkflowWorldPlan> {
  if (input.plan.kind === "native") return input.plan;
  const plan = input.plan;

  await assertCompiledWorkflowWorldPlanIntegrity(plan);

  const destinationRoot = resolve(input.destinationRoot);
  await mkdir(destinationRoot, { recursive: true });
  const materializationRoot = join(await realpath(destinationRoot), plan.backing.identitySha256);
  try {
    await mkdir(materializationRoot);
  } catch (error) {
    if (!isErrnoCode(error, "EEXIST")) throw error;
    const existingPlan = relocatePlan(plan, materializationRoot);
    await assertCompiledWorkflowWorldPlanIntegrity(existingPlan);
    return existingPlan;
  }

  try {
    const packageRootsById = new Map<string, string>();
    for (const [index, selectedPackage] of plan.backing.packages.entries()) {
      const destinationPackageRoot = join(materializationRoot, "packages", String(index));
      await cp(selectedPackage.rootPath, destinationPackageRoot, {
        filter: (sourcePath) =>
          sourcePath === selectedPackage.rootPath ||
          !relative(selectedPackage.rootPath, sourcePath)
            .split(sep)
            .some((segment) => WORKFLOW_WORLD_IGNORED_PACKAGE_PATH_SEGMENTS.has(segment)),
        recursive: true,
        verbatimSymlinks: true,
      });
      packageRootsById.set(selectedPackage.id, destinationPackageRoot);
    }

    for (const selectedPackage of plan.backing.packages) {
      const destinationPackageRoot = requireMaterializedPackageRoot(
        packageRootsById,
        selectedPackage.id,
      );
      for (const [dependencyName, dependencyId] of Object.entries(selectedPackage.dependencies)) {
        if (dependencyId === null) continue;
        const dependencyRoot = requireMaterializedPackageRoot(packageRootsById, dependencyId);
        const mountPath = join(
          destinationPackageRoot,
          "node_modules",
          ...dependencyName.split("/"),
        );
        await mkdir(dirname(mountPath), { recursive: true });
        await symlink(dependencyRoot, mountPath, "junction");
      }
    }

    const materializedPlan = relocatePlan(plan, materializationRoot);
    await assertCompiledWorkflowWorldPlanIntegrity(materializedPlan);
    return materializedPlan;
  } catch (error) {
    await rm(materializationRoot, { force: true, recursive: true });
    throw error;
  }
}

function relocatePlan(
  plan: CompiledHostModuleWorkflowWorldPlan,
  materializationRoot: string,
): CompiledHostModuleWorkflowWorldPlan {
  const packageRootsById = new Map(
    plan.backing.packages.map((selectedPackage, index) => [
      selectedPackage.id,
      join(materializationRoot, "packages", String(index)),
    ]),
  );
  const packages = plan.backing.packages.map((selectedPackage) => {
    const rootPath = requireMaterializedPackageRoot(packageRootsById, selectedPackage.id);
    return {
      ...selectedPackage,
      manifestPath: join(rootPath, "package.json"),
      rootPath,
    };
  });
  const originalEntryPackage = plan.backing.packages.find(
    (selectedPackage) => selectedPackage.id === plan.backing.entryPackageId,
  );
  if (originalEntryPackage === undefined) {
    throw new Error("Workflow world entry package was not materialized.");
  }
  const materializedEntryPackageRoot = requireMaterializedPackageRoot(
    packageRootsById,
    plan.backing.entryPackageId,
  );
  return {
    ...plan,
    backing: {
      ...plan.backing,
      entryPath: join(
        materializedEntryPackageRoot,
        relative(originalEntryPackage.rootPath, plan.backing.entryPath),
      ),
      mode: "materialized",
      packages,
    },
  };
}

function requireMaterializedPackageRoot(
  packageRootsById: ReadonlyMap<string, string>,
  packageId: string,
): string {
  const rootPath = packageRootsById.get(packageId);
  if (rootPath === undefined) {
    throw new Error(
      `Workflow world package backing ${JSON.stringify(packageId)} was not materialized.`,
    );
  }
  return rootPath;
}

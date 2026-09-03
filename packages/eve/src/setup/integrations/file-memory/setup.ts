import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import {
  applyFileMemoryBlob,
  FILE_MEMORY_BLOB_ENVIRONMENTS,
  type FileMemoryBlobPlan,
  prepareFileMemoryBlob,
} from "./vercel.js";

export interface FileMemorySetupDeps {
  readonly applyBlob: typeof applyFileMemoryBlob;
  readonly prepareBlob: typeof prepareFileMemoryBlob;
}

const defaultDeps: FileMemorySetupDeps = {
  applyBlob: applyFileMemoryBlob,
  prepareBlob: prepareFileMemoryBlob,
};

export async function prepareFileMemorySetup(
  context: SetupPrepareContext,
  deps: FileMemorySetupDeps = defaultDeps,
): Promise<FileMemoryBlobPlan> {
  const project = await context.resolveVercelProject("file memory");
  return await deps.prepareBlob({
    appRoot: context.appRoot,
    project,
    signal: context.signal,
  });
}

export async function applyFileMemorySetup(
  plan: FileMemoryBlobPlan,
  context: SetupApplyContext,
  deps: FileMemorySetupDeps = defaultDeps,
) {
  context.presenter.note(
    [
      `Project: ${plan.projectName} (${plan.project.projectId})`,
      `Store: ${plan.storeName}`,
      `Region: ${plan.region}`,
      `Environments: ${FILE_MEMORY_BLOB_ENVIRONMENTS.join(", ")}`,
      "Setup will create or connect a private Vercel Blob resource. Blob usage may incur charges.",
    ].join("\n"),
    "File-memory storage",
  );
  if (plan.regionWarning !== undefined) context.presenter.log.warning(plan.regionWarning);

  const result = await deps.applyBlob({
    appRoot: context.appRoot,
    log: context.presenter.log,
    plan,
    signal: context.signal,
  });
  const setupResult =
    result.action === "create" ? "Created" : result.action === "repair" ? "Repaired" : "Reused";
  return {
    deploymentRequired: true as const,
    facts: [
      { label: "Blob store", value: result.store.name },
      { label: "Vercel project", value: plan.projectName },
      { label: "Region", value: result.store.region },
      { label: "Environments", value: FILE_MEMORY_BLOB_ENVIRONMENTS.join(", ") },
      { label: "Setup result", value: setupResult },
    ],
  };
}

export const FILE_MEMORY_SETUP = defineSetupIntegration({
  kind: "file-memory",
  label: "File memory",
  hint: "Store durable facts in a private Vercel Blob store",
  prepare: prepareFileMemorySetup,
  apply: applyFileMemorySetup,
});

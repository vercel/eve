import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  rollbackRegistryInstall,
  snapshotRegistryInstall,
} from "#cli/commands/registry-install-transaction.js";

import { runEveAdd, type EveAddOutcome, type SpawnLike } from "./eve-add.js";
import type { RegistrySourceTransform } from "./registry-install-plan.js";

export interface LocalRegistryInstallResult {
  readonly outcome: EveAddOutcome;
  readonly transformFailure?: { readonly restored: boolean; readonly changed: readonly string[] };
}

interface LocalRegistryInstallDependencies {
  readonly applyTransform?: typeof applyTransform;
  readonly rollbackInstall?: typeof rollbackRegistryInstall;
  readonly snapshotInstall?: typeof snapshotRegistryInstall;
}

async function applyTransform(
  appRoot: string,
  transform: RegistrySourceTransform,
): Promise<boolean> {
  const path = join(appRoot, transform.target);
  const source = await readFile(path, "utf8");
  const next = transform.apply(source);
  if (next === undefined) return false;
  await writeFile(path, next, "utf8");
  return true;
}

/** Installs one local item and applies an optional source transform under the same rollback boundary. */
export async function installLocalRegistryItem(input: {
  readonly address: string;
  readonly appRoot: string;
  readonly signal?: AbortSignal;
  readonly spawn?: SpawnLike;
  readonly transform?: RegistrySourceTransform;
  readonly withSuspendedSource: <T>(task: () => Promise<T>) => Promise<T>;
  readonly deps?: LocalRegistryInstallDependencies;
}): Promise<LocalRegistryInstallResult> {
  return await input.withSuspendedSource(async () => {
    const snapshots =
      input.transform === undefined
        ? undefined
        : await (input.deps?.snapshotInstall ?? snapshotRegistryInstall)(input.appRoot, {
            files: [{ target: input.transform.target }],
          });
    const outcome = await runEveAdd({
      address: input.address,
      appRoot: input.appRoot,
      signal: input.signal,
      spawn: input.spawn,
    });
    if (outcome.kind !== "installed" || input.transform === undefined) return { outcome };
    try {
      if (await (input.deps?.applyTransform ?? applyTransform)(input.appRoot, input.transform)) {
        return { outcome };
      }
    } catch {}
    return {
      outcome,
      transformFailure: await (input.deps?.rollbackInstall ?? rollbackRegistryInstall)(
        input.appRoot,
        snapshots!,
      ),
    };
  });
}

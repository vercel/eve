import { readFile, writeFile } from "node:fs/promises";

import { reconcileNodeEngine, type NodeEngineOverride } from "../../node-engine.js";

export interface PackageJsonPatch {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
  scripts?: Record<string, string>;
  /**
   * eve's required Node.js range (e.g. `">=24"`). When the target's
   * `engines.node` is absent or is not confined to the scaffolded major, it is
   * set to that pinned major (e.g. `"24.x"`). Existing ranges within the same
   * major are left untouched.
   */
  nodeEngineRequirement?: string;
}

export interface PackageJsonPatchResult {
  changed: boolean;
  nodeEngineOverride?: NodeEngineOverride;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: unknown;
  [key: string]: unknown;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function patchPackageJson(
  path: string,
  patch: PackageJsonPatch,
): Promise<PackageJsonPatchResult> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as PackageJsonShape;
  let changed = false;
  let nodeEngineOverride: NodeEngineOverride | undefined;

  if (patch.dependencies !== undefined) {
    parsed.dependencies = { ...parsed.dependencies, ...patch.dependencies };
    changed = true;
  }
  if (patch.devDependencies !== undefined) {
    parsed.devDependencies = {
      ...parsed.devDependencies,
      ...patch.devDependencies,
    };
    changed = true;
  }
  if (patch.overrides !== undefined) {
    const overrides = isJsonObject(parsed.overrides) ? parsed.overrides : {};
    parsed.overrides = { ...overrides, ...patch.overrides };
    changed = true;
  }
  if (patch.resolutions !== undefined) {
    const resolutions = isJsonObject(parsed.resolutions) ? parsed.resolutions : {};
    parsed.resolutions = { ...resolutions, ...patch.resolutions };
    changed = true;
  }
  if (patch.scripts !== undefined) {
    parsed.scripts = { ...parsed.scripts, ...patch.scripts };
    changed = true;
  }
  if (patch.nodeEngineRequirement !== undefined) {
    const engines = isJsonObject(parsed.engines) ? parsed.engines : {};
    const reconciliation = reconcileNodeEngine(engines.node, patch.nodeEngineRequirement);
    if (reconciliation.kind === "added" || reconciliation.kind === "overridden") {
      parsed.engines = { ...engines, node: reconciliation.next };
      changed = true;
    }
    if (reconciliation.kind === "overridden") {
      nodeEngineOverride = reconciliation;
    }
  }

  if (changed) {
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  return { changed, nodeEngineOverride };
}

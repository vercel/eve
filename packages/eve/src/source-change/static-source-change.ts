import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSourceManifest } from "#discover/manifest.js";
import { applyModelNameToSource } from "#source-change/apply-model-name.js";

/**
 * Outcome of a static source change, returned to upstream callers (CLI, web
 * setup UI) so they can render success or route the bail to a guided fix.
 */
export type ApplyResult =
  | { readonly kind: "applied"; readonly from: string; readonly to: string }
  | {
      readonly kind: "bail";
      readonly reason: string;
      readonly at: { readonly logicalPath: string; readonly line: number };
    };

/**
 * Central, flat API for applying targeted edits to an agent's authored source.
 *
 * Built from a discovery manifest, which already carries every resource's
 * `ModuleSourceRef`, so each operation can locate the file it edits without
 * recompiling. Consumers depend only on this interface.
 */
export interface StaticSourceChange {
  /**
   * Rewrites the agent's `model` in `agent.ts` in place. Bails (no write) when
   * the value isn't a string literal; the bail carries the source location so
   * the caller can offer a manual fix.
   */
  updateModelName(modelName: string): Promise<ApplyResult>;
}

/**
 * Creates the {@link StaticSourceChange} surface bound to one discovered agent.
 */
export function createStaticSourceChange(manifest: AgentSourceManifest): StaticSourceChange {
  return {
    updateModelName: (modelName) => updateAgentModelName(manifest, modelName),
  };
}

async function updateAgentModelName(
  manifest: AgentSourceManifest,
  modelName: string,
): Promise<ApplyResult> {
  const source = manifest.configModule;
  if (source === undefined) {
    return {
      kind: "bail",
      reason: "agent has no agent.ts config module to edit",
      at: { logicalPath: "agent.ts", line: 1 },
    };
  }

  const absolutePath = join(manifest.agentRoot, source.logicalPath);
  const sourceText = await readFile(absolutePath, "utf8");
  const edit = await applyModelNameToSource(sourceText, modelName);

  if (edit.kind === "bail") {
    return {
      kind: "bail",
      reason: edit.reason,
      at: { logicalPath: source.logicalPath, line: edit.line },
    };
  }

  if (edit.nextSource !== sourceText) {
    // Write atomically (temp + rename) so a crash mid-write can't truncate
    // the user's authored source.
    const temporaryPath = `${absolutePath}.${process.pid}.eve-tmp`;
    await writeFile(temporaryPath, edit.nextSource, "utf8");
    await rename(temporaryPath, absolutePath);
  }

  return { kind: "applied", from: edit.from, to: edit.to };
}

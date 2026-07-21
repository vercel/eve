import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSourceManifest } from "#discover/manifest.js";
import { checkAgentConfigSource } from "#source-change/agent-config-string-path.js";
import {
  applyAgentModelSettingsToSource,
  type AgentModelSetting,
  type AgentModelSettingsPatch,
} from "#source-change/apply-agent-model-settings.js";
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

export type ApplyModelSettingsResult =
  | { readonly kind: "applied"; readonly changed: readonly AgentModelSetting[] }
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
  /** Applies the `/model` draft in one source transform and one atomic rename. */
  updateModelSettings(patch: AgentModelSettingsPatch): Promise<ApplyModelSettingsResult>;
}

/**
 * Creates the {@link StaticSourceChange} surface bound to one discovered agent.
 */
export function createStaticSourceChange(manifest: AgentSourceManifest): StaticSourceChange {
  return {
    updateModelName: (modelName) => updateAgentModelName(manifest, modelName),
    updateModelSettings: (patch) => updateAgentModelSettings(manifest, patch),
  };
}

async function updateAgentModelSettings(
  manifest: AgentSourceManifest,
  patch: AgentModelSettingsPatch,
): Promise<ApplyModelSettingsResult> {
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
  const edit = await applyAgentModelSettingsToSource(sourceText, patch);
  if (edit.kind === "bail") {
    return {
      kind: "bail",
      reason: edit.reason,
      at: { logicalPath: source.logicalPath, line: edit.line },
    };
  }

  const refused = await editedSourceBail(sourceText, edit.nextSource, source.logicalPath);
  if (refused !== undefined) return refused;

  await writeSourceIfChanged(absolutePath, sourceText, edit.nextSource);
  return { kind: "applied", changed: edit.changed };
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

  const refused = await editedSourceBail(sourceText, edit.nextSource, source.logicalPath);
  if (refused !== undefined) return refused;

  await writeSourceIfChanged(absolutePath, sourceText, edit.nextSource);

  return { kind: "applied", from: edit.from, to: edit.to };
}

async function writeSourceIfChanged(
  absolutePath: string,
  sourceText: string,
  nextSource: string,
): Promise<void> {
  if (nextSource === sourceText) return;
  // Write atomically so a crash cannot truncate the user's authored source.
  const temporaryPath = `${absolutePath}.${process.pid}.eve-tmp`;
  await writeFile(temporaryPath, nextSource, "utf8");
  await rename(temporaryPath, absolutePath);
}

/**
 * Refuses an edit whose output no longer parses as an agent config. The
 * transforms are AST-guided string surgery, so this invariant turns any
 * editor bug into a bail instead of a broken agent.ts.
 */
async function editedSourceBail(
  sourceText: string,
  nextSource: string,
  logicalPath: string,
): Promise<
  { kind: "bail"; reason: string; at: { logicalPath: string; line: number } } | undefined
> {
  if (nextSource === sourceText) return undefined;
  const invalid = await checkAgentConfigSource(nextSource);
  if (invalid === undefined) return undefined;
  return {
    kind: "bail",
    reason: `the edit produced source eve refuses to write (${invalid})`,
    at: { logicalPath, line: 1 },
  };
}

import type { AgentSourceOwner, CompiledModuleBacking } from "#compiler/module-binding.js";

export type AgentSourceLayer =
  | "framework-default"
  | "extension-package"
  | "extension-override"
  | "application";

export interface AgentModuleCandidate {
  readonly backing: CompiledModuleBacking;
  readonly extensionNamespace?: string;
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}

import type { CompilerDiagnostic } from "#compiler/diagnostics.js";
import type {
  AgentModuleCandidate,
  AgentSourceLayer,
  AgentSourceOwner,
  AgentSourceRegistry,
} from "#compiler/source-graph.js";
import type { DevelopmentExtensionSelection } from "#compiler/development-extensions.js";
import type { AgentSourceManifest } from "#discover/manifest.js";

export interface CompileAgentManifestOptions {
  readonly developmentExtensions?: DevelopmentExtensionSelection;
  readonly diagnostics?: CompilerDiagnostic[];
  readonly sourceRegistries?: readonly AgentSourceRegistry[];
}

export interface NodeCompileInput {
  readonly developmentExtensionCandidates?: readonly AgentModuleCandidate[];
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
  readonly inheritedExternalDependencies: readonly string[];
  readonly isRoot: boolean;
  readonly layer: AgentSourceLayer;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly parentNodeId?: string;
}

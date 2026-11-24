import { installEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import {
  installBundledCompiledArtifacts,
  type BundledCompiledArtifacts,
} from "#runtime/loaders/bundled-artifacts.js";

export interface EveProcessBootInput {
  readonly agentName: string;
  readonly artifacts?: BundledCompiledArtifacts;
}

export function bootEveProcess(input: EveProcessBootInput): void {
  installEveWorkflowQueueNamespace(input.agentName);
  if (input.artifacts !== undefined) installBundledCompiledArtifacts(input.artifacts);
}

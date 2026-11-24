import { installEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import type { PlatformDeclaration } from "#platform/declaration.js";
import { createEntities } from "#platform/entities.js";
import { processApp, type ProcessApp } from "#runtime/app.js";
import {
  installBundledCompiledArtifacts,
  type BundledCompiledArtifacts,
} from "#runtime/loaders/bundled-artifacts.js";

export interface BootPhase<Input> {
  readonly name: string;
  run(app: ProcessApp, input: Input): void | Promise<void>;
}

export interface ProcessBootInput {
  readonly agentName: string;
  readonly platform?: PlatformDeclaration;
  readonly artifacts?: BundledCompiledArtifacts;
}

export const PROCESS_PHASES = [
  {
    name: "platform",
    run(app, input) {
      if (input.platform === undefined) {
        throw new Error(
          "eve reached the platform phase without a platform declaration. The generated process module must pass the platform to bootProcess().",
        );
      }
      app.platform = createEntities(input.platform, undefined);
    },
  },
  {
    name: "queue-namespace",
    run(_app, input) {
      installEveWorkflowQueueNamespace(input.agentName);
    },
  },
  {
    name: "artifacts",
    run(_app, input) {
      if (input.artifacts !== undefined) installBundledCompiledArtifacts(input.artifacts);
    },
  },
] as const satisfies readonly BootPhase<ProcessBootInput>[];

export type ProcessPhaseName = (typeof PROCESS_PHASES)[number]["name"];

export function bootProcess(input: ProcessBootInput, through: ProcessPhaseName): void {
  const app = processApp();
  const end = PROCESS_PHASES.findIndex((phase) => phase.name === through) + 1;
  for (; app.bootedPhases < end; app.bootedPhases += 1) {
    PROCESS_PHASES[app.bootedPhases]!.run(app, input);
  }
}

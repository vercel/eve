import { installEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import type { PlatformDeclaration } from "#platform/declaration.js";
import { createEntities } from "#platform/entities.js";
import { processApp, type ProcessApp } from "#runtime/app.js";
import {
  installBundledCompiledArtifacts,
  type BundledCompiledArtifacts,
} from "#runtime/loaders/bundled-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  compiledSessionAgent,
  loadCompiledSessionAgent,
} from "#runtime/sessions/compiled-session-agent.js";

export interface BootPhase<Input> {
  readonly name: string;
  run(app: ProcessApp, input: Input): void | Promise<void>;
}

export interface ProcessBootInput {
  readonly agentName: string;
  readonly platform?: PlatformDeclaration<unknown>;
  readonly artifacts?: BundledCompiledArtifacts;
}

export const PROCESS_PHASES = [
  {
    name: "platform",
    async run(app, input) {
      const declaration = input.platform;
      if (declaration === undefined) {
        throw new Error(
          "eve reached the platform phase without a platform declaration. The generated process module must pass the declaration it imports from the platform module to bootProcess().",
        );
      }
      const context = await declaration.context?.();
      app.platform = createEntities(declaration, context);
      app.declaration = declaration;
      app.context = context;
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
      if (input.artifacts !== undefined) {
        installBundledCompiledArtifacts(input.artifacts);
        (globalThis as Record<symbol, unknown>)[Symbol.for("eve.compiled-agent-loader")] = {
          compiledSessionAgent,
          loadCompiledBundle: getCompiledRuntimeAgentBundle,
          loadCompiledManifest,
          loadCompiledSessionAgent,
        };
      }
    },
  },
] as const satisfies readonly BootPhase<ProcessBootInput>[];

export type ProcessPhaseName = (typeof PROCESS_PHASES)[number]["name"];

export async function bootProcess(
  input: ProcessBootInput,
  through: ProcessPhaseName,
): Promise<ProcessApp> {
  const app = processApp();
  const end = PROCESS_PHASES.findIndex((phase) => phase.name === through) + 1;
  app.booting = app.booting.then(async () => {
    for (; app.bootedPhases < end; app.bootedPhases += 1) {
      await PROCESS_PHASES[app.bootedPhases]!.run(app, input);
    }
  });
  await app.booting;
  return app;
}

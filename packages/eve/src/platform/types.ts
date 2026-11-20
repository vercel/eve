import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import type { HostRouteTable } from "#internal/nitro/host/host-routes.js";
import type { createEveVercelOptions } from "#platform/vercel/build-output-config.js";

export type PlatformNitroOptionsInput = Parameters<typeof createEveVercelOptions>[0];

export type PlatformNitroOptions = ReturnType<typeof createEveVercelOptions>;

export type PlatformSandboxPrewarmInput = Parameters<typeof prewarmAppSandboxes>[0];

export interface PlatformBuildOutput {
  nitroOptions(input: PlatformNitroOptionsInput): PlatformNitroOptions;
  normalizeServiceOutput(outputDir: string, routes: HostRouteTable): Promise<void>;
  prewarmSandboxes(input: PlatformSandboxPrewarmInput): Promise<boolean>;
  usesLocalSchedules(manifest: Pick<CompiledAgentManifest, "scheduleCollections">): boolean;
  hasScheduleCollections(manifest: {
    readonly scheduleCollections?: readonly { readonly providerKind: string }[];
  }): boolean;
  scheduleTaskName(input: { readonly agentName?: string; readonly scheduleId: string }): string;
  scheduleConsumerModulePath(): string;
  localSchedulesPluginModulePath(): string;
}

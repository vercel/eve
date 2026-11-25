import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import type { HostRouteTable } from "#internal/nitro/host/host-routes.js";
import type { createEveVercelOptions } from "#platform/vercel/build-output-config.js";

export interface PlatformNitroOptionsInput {
  readonly agentName: string;
  readonly enabled: boolean;
  readonly publicRoutePrefix?: string;
  readonly routeTable: Pick<HostRouteTable, "routes" | "scheduleTasks">;
  readonly workspaceMember?: boolean;
}

export type PlatformNitroOptions = ReturnType<typeof createEveVercelOptions>;

export type PlatformSandboxPrewarmInput = Parameters<typeof prewarmAppSandboxes>[0];

export interface PlatformBuildSchedules {
  usesLocal(manifest: Pick<CompiledAgentManifest, "scheduleCollections">): boolean;
  hasCollections(manifest: {
    readonly scheduleCollections?: readonly { readonly providerKind: string }[];
  }): boolean;
  taskName(input: { readonly agentName?: string; readonly scheduleId: string }): string;
  consumerModulePath(): string;
  localPluginModulePath(): string;
}

export interface PlatformBuildOutput {
  nitroOptions(input: PlatformNitroOptionsInput): PlatformNitroOptions;
  normalizeServiceOutput(outputDir: string, routes: HostRouteTable): Promise<void>;
  prewarmSandboxes(input: PlatformSandboxPrewarmInput): Promise<boolean>;
  readonly schedules: PlatformBuildSchedules;
}

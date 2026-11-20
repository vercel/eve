import type { CurrentVercelProject } from "#channel/auth/types.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import type { HostRouteTable } from "#internal/nitro/host/host-routes.js";
import type { createEveVercelOptions } from "#platform/vercel/build-output-config.js";
import type { VercelSandbox } from "#platform/vercel/sandbox/provider.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

export type DeploymentEnvironmentKind = "development" | "preview" | "production";

export interface DeploymentBuild {
  readonly deployedAt: string | undefined;
  readonly gitBranch: string | undefined;
  readonly gitSha: string | undefined;
}

export type DeploymentHost = "vercel" | "node";

export interface PlatformDeployment {
  host(): DeploymentHost;
  environmentKind(): DeploymentEnvironmentKind | undefined;
  environmentName(): string | undefined;
  projectId(): string | undefined;
  deploymentId(): string | undefined;
  hostedDeploymentId(): string | undefined;
  build(): DeploymentBuild | undefined;
  productionHost(): string | undefined;
  deploymentHost(): string | undefined;
  publicHost(): string | undefined;
}

export type PlatformProject = CurrentVercelProject;

export type PlatformProjectResolver = () =>
  | PlatformProject
  | undefined
  | Promise<PlatformProject | undefined>;

export interface PlatformIdentity {
  token(): Promise<string>;
  isPlatformIssuer(issuer: string | undefined): boolean;
  currentProject(): PlatformProject | undefined;
  requestProject(request: Request): Promise<PlatformProject | undefined>;
  withRequestProject<T>(
    input: { readonly request: Request; readonly resolveCurrentProject: PlatformProjectResolver },
    callback: () => Promise<T> | T,
  ): Promise<T>;
  callbackHeaders(url: string, isTrustedOrigin: (url: URL) => boolean): Record<string, string>;
}

export interface PlatformTelemetry {
  traceSessionAttribute(): string | undefined;
  runtimeSpanProcessor(): SpanProcessor;
}

export type BuildTarget = "vercel" | "node";

export interface PlatformBuild {
  target(): BuildTarget;
}

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

export interface PlatformSandboxes {
  readonly hostedEnvironment: (typeof VercelSandbox)["environment"];
}

export interface PlatformSchedules {
  defaultProvider(): ScheduleProvider;
}

export interface Platform {
  readonly build: PlatformBuild;
  readonly deployment: PlatformDeployment;
  readonly identity: PlatformIdentity;
}

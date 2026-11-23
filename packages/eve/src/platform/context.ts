import { createVercelPlatformContext } from "#platform/vercel/context.js";
import type { WorkspaceAgentTransport } from "#public/definitions/workspace-agent.js";
import { eveRuntime } from "#runtime/eve-runtime.js";

export type PlatformTarget = "vercel";

export type BuildTarget = "vercel" | "node";

export type DeploymentEnvironmentKind = "development" | "preview" | "production";

export interface DeploymentBuild {
  readonly deployedAt: string | undefined;
  readonly gitBranch: string | undefined;
  readonly gitSha: string | undefined;
}

export interface PlatformDeployment {
  environmentKind(): DeploymentEnvironmentKind | undefined;
  environmentName(): string | undefined;
  projectId(): string | undefined;
  deploymentId(): string | undefined;
  hostedDeploymentId(): string | undefined;
  build(): DeploymentBuild | undefined;
  productionHost(): string | undefined;
  deploymentHost(): string | undefined;
  publicHost(): string | undefined;
  isPlatformDevelopmentServer(): boolean;
}

export interface PlatformIdentity {
  token(): Promise<string>;
  isPlatformIssuer(issuer: string | undefined): boolean;
  withDevelopmentRequestScope<T>(
    input: { readonly appRoot: string; readonly request: Request },
    callback: () => Promise<T>,
  ): Promise<T>;
  callbackHeaders(url: string, isTrustedOrigin: (url: URL) => boolean): Record<string, string>;
}

export interface PlatformBuild {
  target(): BuildTarget;
  outputDirectory(appRoot: string): string | undefined;
  localSandboxPrewarmFailure(providerName: string, error: unknown): Error | undefined;
}

export interface PlatformSandbox {
  hostedAvailable(): boolean;
  credentialTransforms(): boolean;
  stopsOnExit(): boolean;
}

export interface PlatformWorkspace {
  transport(routePath: string): WorkspaceAgentTransport | undefined;
}

export interface PlatformTelemetry {
  traceSessionAttribute(): string | undefined;
}

export interface PlatformContext {
  readonly target: PlatformTarget;
  readonly build: PlatformBuild;
  readonly deployment: PlatformDeployment;
  readonly identity: PlatformIdentity;
  readonly sandbox: PlatformSandbox;
  readonly telemetry: PlatformTelemetry;
  readonly workspace: PlatformWorkspace;
}

let fallbackPlatform: PlatformContext | undefined;

export function platformContext(): PlatformContext {
  return eveRuntime().platform ?? (fallbackPlatform ??= createVercelPlatformContext());
}

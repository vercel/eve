import type { DeploymentBuild, DeploymentScope, Identity } from "#platform/entities.js";
import type { HostServices } from "#platform/services.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";
import type { WorkspaceAgentTransport } from "#public/definitions/workspace-agent.js";
import { processApp } from "#runtime/app.js";

export type BuildTarget = "vercel" | "node";

export type DeploymentEnvironmentKind = "development" | "preview" | "production";

export interface PlatformDeployment {
  environmentKind(): DeploymentEnvironmentKind | undefined;
  deploymentId(): string | undefined;
  hostedDeploymentId(): string | undefined;
  build(): DeploymentBuild | undefined;
  productionHost(): string | undefined;
  deploymentHost(): string | undefined;
  publicHost(): string | undefined;
  isPlatformDevelopmentServer(): boolean;
  scope(): DeploymentScope | undefined;
  stopsSandboxesOnExit(): boolean;
}

export interface PlatformIdentity {
  token(): Promise<string>;
  verifyOidcCaller?: Identity["verifyOidcCaller"];
  developmentCaller?: Identity["developmentCaller"];
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

export interface PlatformWorkspace {
  transport(routePath: string): WorkspaceAgentTransport | undefined;
}

export interface PlatformTelemetry {
  traceSessionAttribute(): string | undefined;
}

export interface PlatformContext {
  readonly build: PlatformBuild;
  readonly deployment: PlatformDeployment;
  readonly identity: PlatformIdentity;
  readonly services?: HostServices;
  readonly telemetry: PlatformTelemetry;
  readonly workspace: PlatformWorkspace;
}

export function createPlatformContext(): PlatformContext {
  return createVercelPlatformContext();
}

let fallbackPlatform: PlatformContext | undefined;

export function platformContext(): PlatformContext {
  return processApp().platform ?? (fallbackPlatform ??= createPlatformContext());
}

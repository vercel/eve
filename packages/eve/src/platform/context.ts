import type { CurrentVercelProject } from "#channel/auth/types.js";
import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";
import type { WorkspaceAgentTransport } from "#public/definitions/workspace-agent.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import type { VercelSandboxSession } from "#public/sandbox/vercel.js";
import type {
  VercelSandboxCreateOptions,
  VercelSandboxRuntimeOptions,
} from "#public/sandbox/vercel-sandbox.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";
import type { SandboxProvider, WithPrepareOption } from "#sandbox/provider.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

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

export interface PlatformBuild {
  target(): BuildTarget;
  outputDirectory(appRoot: string): string | undefined;
  localSandboxPrewarmFailure(providerName: string, error: unknown): Error | undefined;
}

export type HostedSandboxEnvironment = ReturnType<
  SandboxProvider<
    WithPrepareOption<VercelSandboxCreateOptions, VercelSandboxSession> | undefined,
    VercelSandboxRuntimeOptions,
    VercelSandboxSession
  >["environment"]
>;

export interface PlatformSandbox {
  hostedAvailable(): boolean;
  hostedEnvironment(options?: VercelSandboxCreateOptions): HostedSandboxEnvironment;
  credentialTransforms(): boolean;
  stopsOnExit(): boolean;
}

export interface PlatformMemory {
  defaultDocumentBackend(): MemoryDocumentBackend | undefined;
}

export interface PlatformSchedules {
  defaultProvider(): ScheduleProvider;
}

export interface PlatformWorkspace {
  transport(routePath: string): WorkspaceAgentTransport | undefined;
}

export interface PlatformModels {
  gatewayCredential(rejectedToken?: string): Promise<DevelopmentModelCredential>;
}

export interface PlatformTelemetry {
  traceSessionAttribute(): string | undefined;
  runtimeSpanProcessor(): SpanProcessor;
}

export interface PlatformContext {
  readonly target: PlatformTarget;
  readonly build: PlatformBuild;
  readonly deployment: PlatformDeployment;
  readonly identity: PlatformIdentity;
  readonly memory: PlatformMemory;
  readonly models: PlatformModels;
  readonly sandbox: PlatformSandbox;
  readonly schedules: PlatformSchedules;
  readonly telemetry: PlatformTelemetry;
  readonly workspace: PlatformWorkspace;
}

const PLATFORM_CONTEXT = Symbol.for("eve.platform-context");

interface PlatformContextHolder {
  [PLATFORM_CONTEXT]?: PlatformContext;
}

const holder = globalThis as PlatformContextHolder;

export function setPlatformContext(context: PlatformContext): () => void {
  const previous = holder[PLATFORM_CONTEXT];
  holder[PLATFORM_CONTEXT] = context;
  return () => {
    holder[PLATFORM_CONTEXT] = previous;
  };
}

export function platformContext(): PlatformContext {
  return (holder[PLATFORM_CONTEXT] ??= createVercelPlatformContext());
}

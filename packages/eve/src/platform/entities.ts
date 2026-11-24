import type { JWTPayload } from "#compiled/jose/index.js";
import type {
  ResolvedOidcAuthStrategy,
  RouteStrategyAuthenticationResult,
} from "#channel/auth/types.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import { isPlatformDeclaration, type PlatformDeclaration } from "#platform/declaration.js";
import type { VercelSandbox } from "#platform/vercel/sandbox/provider.js";
import type { WorkspaceAgentTransport } from "#public/definitions/workspace-agent.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

export type DeploymentEnvironment = "development" | "preview" | "production";

export interface DeploymentBuild {
  readonly deployedAt: string | undefined;
  readonly gitBranch: string | undefined;
  readonly gitSha: string | undefined;
}

export interface DeploymentScope {
  readonly platform: string;
  readonly id: string;
  readonly environment: string;
  readonly variant: string | null;
}

export interface Deployment {
  environment(): DeploymentEnvironment | undefined;
  deploymentId(): string | undefined;
  productionHost(): string | undefined;
  publicHost(): string | undefined;
  scope(): DeploymentScope | undefined;
  invocationData?(): Readonly<Record<string, string>>;
  build?(): DeploymentBuild | undefined;
  localDevelopment?(): boolean;
}

export interface Triggers {
  readonly schedules: ScheduleProvider;
}

type HostedSandboxEnvironment = (typeof VercelSandbox)["environment"];

export interface Compute {
  readonly name: string;
  readonly selectByDefault: boolean;
  readonly credentialTransforms: boolean;
  readonly platformStopsSandboxes: boolean;
  environment(
    ...options: Parameters<HostedSandboxEnvironment>
  ): ReturnType<HostedSandboxEnvironment>;
}

export interface Storage {
  readonly documents?: MemoryDocumentBackend;
}

export interface OidcCallerInput {
  readonly issuer: string;
  readonly payload: JWTPayload;
  readonly strategy: ResolvedOidcAuthStrategy;
}

export type OidcCallerVerdict =
  | Extract<RouteStrategyAuthenticationResult, { kind: "authenticated" | "caller-not-allowed" }>
  | { readonly kind: "continue"; readonly currentProject: boolean; readonly runtime: boolean };

export interface Identity {
  verifyOidcCaller?(input: OidcCallerInput): OidcCallerVerdict;
  developmentCaller?(caller: SessionAuthContext): boolean;
  developmentScope?<T>(
    input: { readonly appRoot: string; readonly request: Request },
    run: () => Promise<T>,
  ): Promise<T>;
}

export interface Network {
  self?(url: string, isTrustedOrigin: (url: URL) => boolean): Readonly<Record<string, string>>;
  peer?(routePath: string): WorkspaceAgentTransport | undefined;
  token?(): Promise<string>;
}

export interface Telemetry {
  readonly sessionAttribute?: string;
  spanProcessor?(): SpanProcessor;
}

export interface Build {
  readonly entry?: string;
  readonly conditions?: readonly string[];
  platformOutput?(): boolean;
  outputDirectory?(appRoot: string): string | undefined;
  sandboxPrewarmFailure?(providerName: string, error: unknown): Error | undefined;
}

export interface ModelCredentials {
  resolve(rejectedToken?: string): Promise<DevelopmentModelCredential>;
}

interface MadeEntities {
  readonly deployment: Deployment;
  readonly triggers: Triggers | undefined;
  readonly compute: Compute | undefined;
  readonly storage: Storage;
  readonly identity: Identity;
  readonly network: Network;
  readonly telemetry: Telemetry;
  readonly models: ModelCredentials | undefined;
}

export interface Entities extends MadeEntities {
  readonly build: Build;
}

export interface PlatformApp {
  readonly platform: Entities;
}

type EntityName = keyof MadeEntities;

const ENTITY_NAMES = [
  "deployment",
  "triggers",
  "compute",
  "storage",
  "identity",
  "network",
  "telemetry",
  "models",
] as const satisfies readonly EntityName[];

const DEFAULT_ENTITIES: { readonly [Name in EntityName]: () => MadeEntities[Name] } = {
  deployment: () => {
    throw new Error("A platform declaration must give `deployment`.");
  },
  triggers: () => undefined,
  compute: () => undefined,
  storage: () => ({}),
  identity: () => ({}),
  network: () => ({}),
  telemetry: () => ({}),
  models: () => undefined,
};

const DEFAULT_SANDBOX_PROVIDER_NAMES = new Set(["default", "docker", "just-bash"]);

export function createEntities<Context>(
  declaration: PlatformDeclaration<Context>,
  context: Context,
): Entities {
  if (!isPlatformDeclaration(declaration)) {
    throw new Error(
      "eve can only make the entities of a platform declaration. Build the platform with definePlatform({ deployment, ... }).",
    );
  }
  const made = new Map<EntityName, unknown>();
  const making: EntityName[] = [];

  function entity<Name extends EntityName>(name: Name): MadeEntities[Name] {
    if (made.has(name)) return made.get(name) as MadeEntities[Name];
    if (making.includes(name)) {
      const cycle = [...making.slice(making.indexOf(name)), name].join(" → ");
      throw new Error(
        `The entity factories of the platform read in a cycle: ${cycle}. Make one of them read the next entity only when it uses it.`,
      );
    }
    making.push(name);
    try {
      const factory = declaration[name];
      const value = (
        factory === undefined ? DEFAULT_ENTITIES[name]() : factory(app, context)
      ) as MadeEntities[Name];
      if (isPromiseLike(value)) {
        throw new Error(
          `The "${name}" factory of the platform returned a promise. Platform factories are synchronous; move the work into context().`,
        );
      }
      if (name === "compute") assertComputeName(value as Compute | undefined);
      made.set(name, value);
      return value;
    } finally {
      making.pop();
    }
  }

  const getters = Object.fromEntries(
    ENTITY_NAMES.map((name) => [name, { enumerable: true, get: () => entity(name) }]),
  );
  const entities = Object.freeze(
    Object.defineProperties({ build: declaration.build ?? {} }, getters),
  ) as Entities;
  const app: PlatformApp = { platform: entities };
  return entities;
}

function assertComputeName(compute: Compute | undefined): void {
  const name = compute?.name;
  if (name !== undefined && (name === "" || DEFAULT_SANDBOX_PROVIDER_NAMES.has(name))) {
    throw new Error(
      `A hosted sandbox can't be named "${name}", because DefaultSandbox records that name for its own providers. Name it after the sandbox service it runs.`,
    );
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

import type {
  ResolvedOidcAuthStrategy,
  RouteStrategyAuthenticationResult,
} from "#channel/auth/types.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import { isPlatformDeclaration, type PlatformDeclaration } from "#platform/declaration.js";
import { createLifetime, type Lifetime } from "#runtime/lifetime.js";
import type { VercelSandbox } from "#platform/vercel/sandbox/provider.js";
import type { WorkspaceAgentTransport } from "#public/definitions/workspace-agent.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

/** The kind of a deployment, as eve uses it to choose defaults. */
export type DeploymentEnvironment = "development" | "preview" | "production";

/** The source facts of a deployment that eve reports in its info route. */
export interface DeploymentRevision {
  /** The time of the deployment, as an ISO 8601 string. */
  readonly deployedAt: string | undefined;
  /** The Git branch that the deployment builds. */
  readonly gitBranch: string | undefined;
  /** The Git commit SHA that the deployment builds. */
  readonly gitSha: string | undefined;
}

/** The place of a deployment, which keys state that its deployments share, such as memory. */
export interface DeploymentScope {
  /** The name of the platform, for example `"cloudflare"`. */
  readonly platform: string;
  /** The ID of the project or the application on the platform. */
  readonly id: string;
  /** The environment of the deployment, for example `"production"`. */
  readonly environment: string;
  /** A finer part of the environment, such as a branch, or `null` when there is none. */
  readonly variant: string | null;
}

/** Tells eve where and what the current deployment is. Each platform gives this entity. */
export interface Deployment {
  /** Returns the kind of the deployment, or `undefined` when it is unknown. */
  environment(): DeploymentEnvironment | undefined;
  /** Returns the ID of this deployment, or `undefined` when there is none. */
  deploymentId(): string | undefined;
  /** Returns the host of the production deployment, without a scheme. */
  productionHost(): string | undefined;
  /** Returns the public host of this deployment, without a scheme. */
  publicHost(): string | undefined;
  /** Returns the scope that the deployments of this application share. */
  scope(): DeploymentScope | undefined;
  /** Returns data that eve adds to the invocation data of each session. */
  invocationData?(): Readonly<Record<string, string>>;
  /** Returns the source facts of the deployment. */
  revision?(): DeploymentRevision | undefined;
  /** Returns `true` when the deployment runs on the computer of a developer. */
  localDevelopment?(): boolean;
}

/** An authored schedule from `agent/schedules/`, as eve gives it to {@link Triggers.register}. */
export interface AuthoredSchedule {
  /** The name of the schedule, from its path. Pass it to `runAuthoredSchedule()`. */
  readonly name: string;
  /** The cron expression of the schedule. */
  readonly cron: string;
  /** The IANA timezone of the cron expression, when the schedule gives one. */
  readonly timezone?: string;
}

/** Tells eve which service keeps and fires dynamic and authored schedules. */
export interface Triggers {
  /** The default `provider` of `defineDynamicSchedules()`. */
  readonly schedules: ScheduleProvider;
  /**
   * Receives the authored schedules when the app boots, when `build.schedules.authored` is set.
   * Each process of the app calls it, so make it idempotent. When a schedule comes due, call
   * `runAuthoredSchedule()`.
   */
  register?(schedules: readonly AuthoredSchedule[]): void | Promise<void>;
}

type HostedSandboxEnvironment = (typeof VercelSandbox)["environment"];

/** Tells eve where untrusted code runs: the hosted sandbox of the platform. */
export interface Compute {
  /** The name of the sandbox provider. It cannot be a name of a built-in provider. */
  readonly name: string;
  /** Whether `DefaultSandbox` selects this sandbox when the agent selects none. */
  readonly selectByDefault: boolean;
  /** Whether the sandbox can change the credentials of its outbound requests. */
  readonly credentialTransforms: boolean;
  /** Whether the platform stops idle sandboxes itself, so eve does not stop them. */
  readonly platformStopsSandboxes: boolean;
  /** Makes the sandbox environment for one set of options. */
  environment(
    ...options: Parameters<HostedSandboxEnvironment>
  ): ReturnType<HostedSandboxEnvironment>;
}

/** Tells eve where memory documents stay. */
export interface Storage {
  /** The default backend of `fileMemory()`. */
  readonly documents?: MemoryDocumentBackend;
}

/** The claims of a verified OIDC token. */
export interface OidcClaims {
  /** The issuer of the token. */
  readonly iss?: string | undefined;
  /** The subject of the token. */
  readonly sub?: string | undefined;
  /** The audience of the token. */
  readonly aud?: string | readonly string[] | undefined;
  /** The ID of the token. */
  readonly jti?: string | undefined;
  /** The time, in seconds, before which the token is not valid. */
  readonly nbf?: number | undefined;
  /** The time, in seconds, when the token expires. */
  readonly exp?: number | undefined;
  /** The time, in seconds, when the issuer made the token. */
  readonly iat?: number | undefined;
  /** The other claims of the token. */
  readonly [claim: string]: unknown;
}

/** The OIDC caller that route auth gives to {@link Identity.verifyOidcCaller}. */
export interface OidcCallerInput {
  /** The issuer that verified the token. */
  readonly issuer: string;
  /** The claims of the verified token. */
  readonly payload: OidcClaims;
  /** The OIDC strategy of the route. */
  readonly strategy: ResolvedOidcAuthStrategy;
}

/**
 * The verdict of {@link Identity.verifyOidcCaller}: accept the caller, refuse it, or let route
 * auth continue with its claim matchers.
 */
export type OidcCallerVerdict =
  | Extract<RouteStrategyAuthenticationResult, { kind: "authenticated" | "caller-not-allowed" }>
  | { readonly kind: "continue"; readonly currentProject: boolean; readonly runtime: boolean };

/** Tells eve who calls in. */
export interface Identity {
  /** Gives a verdict on a caller with a verified OIDC token. */
  verifyOidcCaller?(input: OidcCallerInput): OidcCallerVerdict;
  /** Returns `true` when a caller is a developer of this deployment. */
  developmentCaller?(caller: SessionAuthContext): boolean;
  /** Runs a development request in the scope that the platform needs for it. */
  developmentScope?<T>(
    input: { readonly appRoot: string; readonly request: Request },
    run: () => Promise<T>,
  ): Promise<T>;
}

/** Tells eve how it calls this deployment and other services. */
export interface Network {
  /** Returns the headers of a callback to this deployment at `url`. */
  self?(url: string, isTrustedOrigin: (url: URL) => boolean): Readonly<Record<string, string>>;
  /** Returns the transport to a workspace agent at `routePath`. */
  peer?(routePath: string): WorkspaceAgentTransport | undefined;
  /** Returns the token that eve shows to another service. */
  token?(): Promise<string>;
  /**
   * Fetches an untrusted URL safely. eve uses it on runtimes where it cannot pin the address of a
   * request itself. Without it, eve refuses untrusted URLs there.
   */
  fetchUntrusted?(request: Request): Promise<Response>;
}

/** Tells eve where traces go. */
export interface Telemetry {
  /** The span attribute that holds the session ID. */
  readonly sessionAttribute?: string;
  /** Returns the span processor that eve adds to the tracer provider. */
  spanProcessor?(): SpanProcessor;
}

/** The hosted sandbox that the build prewarms. */
export interface BuildPrewarm {
  /** The sandbox that the build uses. The build never calls the `compute` factory. */
  readonly compute: Compute;
  /** Returns the error that stops the build when the prewarm fails, or `undefined` to continue. */
  failure?(providerName: string, error: unknown): Error | undefined;
}

/** Tells eve how it packages the application. The build reads only this entity. */
export interface Build {
  /** The hosted sandbox that the build prewarms. */
  readonly prewarm?: BuildPrewarm;
  /** Build data of schedules. */
  readonly schedules?: {
    /** The kind of the default schedule provider, which the compiler writes. */
    readonly kind?: string;
    /**
     * When `true`, the platform's `Triggers` runs authored schedules: the build adds no scheduled
     * tasks of its own, and eve gives the schedules to `triggers.register()` at boot.
     */
    readonly authored?: boolean;
  };
  /** A module of the platform that starts the app and serves it. */
  readonly entry?: string;
  /** The export conditions of the runtime of the entry. */
  readonly conditions?: readonly string[];
  /** Returns `true` when the build writes the output format of the platform. */
  platformOutput?(): boolean;
  /** Returns the directory of the build output. */
  outputDirectory?(appRoot: string): string | undefined;
}

/** Tells eve where model credentials come from in development. */
export interface ModelCredentials {
  /** Returns a credential. `rejectedToken` is a token that the model service refused. */
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

/** The entities that eve made from the platform declaration of the app. */
export interface Entities extends MadeEntities {
  readonly build: Build;
}

/** The app that an entity factory receives. It reads the other entities from it. */
export interface PlatformApp {
  /** The entities of the app. */
  readonly platform: Entities;
  /** The lifetime of the app. Register the cleanups of the clients that a factory opens. */
  readonly lifetime: Lifetime;
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
  lifetime: Lifetime = createLifetime(),
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
  const app: PlatformApp = { platform: entities, lifetime };
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

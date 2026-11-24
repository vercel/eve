import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import type { PlatformContext } from "#platform/context.js";
import type { PlatformBuildOutput } from "#platform/types.js";
import type { VercelSandbox } from "#platform/vercel/sandbox/provider.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

type HostedSandboxEnvironment = (typeof VercelSandbox)["environment"];

export interface HostedSandbox {
  readonly name: string;
  readonly selectByDefault: boolean;
  readonly credentialTransforms: boolean;
  environment(
    ...options: Parameters<HostedSandboxEnvironment>
  ): ReturnType<HostedSandboxEnvironment>;
}

export interface ModelCredentials {
  resolve(rejectedToken?: string): Promise<DevelopmentModelCredential>;
}

export interface AgentRuns {
  spanProcessor(): SpanProcessor;
}

export interface HostServiceVersions {
  readonly "1": {
    readonly agentRuns?: AgentRuns;
    readonly buildOutput?: PlatformBuildOutput;
    readonly documentStore?: MemoryDocumentBackend;
    readonly hostedSandbox?: HostedSandbox;
    readonly modelCredentials?: ModelCredentials;
    readonly scheduleProvider?: ScheduleProvider;
  };
}

export type HostServices = HostServiceVersions["1"];

const HOST_SERVICES = Symbol.for("eve.host-services");
const DEFAULT_SANDBOX_PROVIDER_NAMES = new Set(["default", "docker", "just-bash"]);

export function hostServices<Version extends keyof HostServiceVersions>(
  version: Version,
  services: HostServiceVersions[Version] = {},
): HostServices {
  if (version !== "1") {
    throw new Error(
      `eve host services version "${String(version)}" isn't supported. This version of eve supports "1".`,
    );
  }
  const sandboxName = services.hostedSandbox?.name;
  if (
    sandboxName !== undefined &&
    (sandboxName === "" || DEFAULT_SANDBOX_PROVIDER_NAMES.has(sandboxName))
  ) {
    throw new Error(
      `A hosted sandbox can't be named "${sandboxName}", because DefaultSandbox records that name for its own providers. Name it after the sandbox service it runs.`,
    );
  }
  const built = { ...services };
  Object.defineProperty(built, HOST_SERVICES, { value: true });
  return Object.freeze(built);
}

function installedServices(platform: PlatformContext): HostServices | undefined {
  const { services } = platform;
  if (services === undefined) return undefined;
  if (Reflect.get(services, HOST_SERVICES) !== true) {
    throw new Error(
      `The installed eve platform's services weren't built with hostServices(), so eve can't read them. Build them with hostServices("1", { ... }).`,
    );
  }
  return services;
}

export function hostService<Name extends keyof HostServices>(
  platform: PlatformContext,
  name: Name,
  builtIn: () => HostServices[Name],
): HostServices[Name] {
  const services = installedServices(platform);
  return services === undefined ? builtIn() : services[name];
}

export function hasHostService(platform: PlatformContext, name: keyof HostServices): boolean {
  const services = installedServices(platform);
  return services === undefined || services[name] !== undefined;
}

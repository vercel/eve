import type { PlatformContext } from "#platform/context.js";
import type { GatewayCredentialResolver } from "#platform/models.js";
import type { PlatformBuildOutput } from "#platform/types.js";
import type { VercelSandbox } from "#platform/vercel/sandbox/provider.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";
import type { SpanProcessor } from "#tracing/eve/otel-configuration.js";

export interface HostCapabilityVersions {
  readonly "1": {
    readonly agentRuns?: boolean;
    readonly documentStore?: boolean;
    readonly hostedSandbox?: boolean;
    readonly modelCredentials?: boolean;
    readonly sandboxCredentialTransforms?: boolean;
    readonly scheduleProvider?: boolean;
    readonly stopsSandboxesOnExit?: boolean;
  };
}

export type HostCapabilityName = keyof HostCapabilityVersions["1"];

export type HostCapabilities = { readonly [Name in HostCapabilityName]: boolean };

export interface PlatformHooks {
  agentRunsSpanProcessor?(): SpanProcessor;
  buildOutput?: PlatformBuildOutput;
  documentStore?(): MemoryDocumentBackend | undefined;
  hostedSandbox?: (typeof VercelSandbox)["environment"];
  modelCredentials?: GatewayCredentialResolver;
  scheduleProvider?(): ScheduleProvider;
}

type CapabilityHook = Exclude<keyof PlatformHooks, "buildOutput">;

const HOOK_CAPABILITY = {
  agentRunsSpanProcessor: "agentRuns",
  documentStore: "documentStore",
  hostedSandbox: "hostedSandbox",
  modelCredentials: "modelCredentials",
  scheduleProvider: "scheduleProvider",
} as const satisfies Record<CapabilityHook, HostCapabilityName>;

const HOST_CAPABILITIES = Symbol.for("eve.host-capabilities");

export function hostCapabilities<Version extends keyof HostCapabilityVersions>(
  version: Version,
  options: HostCapabilityVersions[Version] = {},
): HostCapabilities {
  if (version !== "1") {
    throw new Error(
      `eve host capabilities version "${String(version)}" isn't supported. This version of eve supports "1".`,
    );
  }
  if (options.sandboxCredentialTransforms === true && options.hostedSandbox !== true) {
    throw new Error(
      "A host can declare sandboxCredentialTransforms only together with hostedSandbox, because the transforms run inside its hosted sandbox.",
    );
  }
  const capabilities: HostCapabilities = {
    agentRuns: options.agentRuns === true,
    documentStore: options.documentStore === true,
    hostedSandbox: options.hostedSandbox === true,
    modelCredentials: options.modelCredentials === true,
    sandboxCredentialTransforms: options.sandboxCredentialTransforms === true,
    scheduleProvider: options.scheduleProvider === true,
    stopsSandboxesOnExit: options.stopsSandboxesOnExit === true,
  };
  Object.defineProperty(capabilities, HOST_CAPABILITIES, { value: true });
  return Object.freeze(capabilities);
}

export function hasCapability(platform: PlatformContext, name: HostCapabilityName): boolean {
  const { capabilities } = platform;
  if (Reflect.get(capabilities, HOST_CAPABILITIES) !== true) {
    throw new Error(
      `The installed eve platform's capabilities weren't built with hostCapabilities(), so eve can't tell whether it supports "${name}". Build them with hostCapabilities("1", { ... }).`,
    );
  }
  return capabilities[name];
}

export function platformHook<Name extends CapabilityHook>(
  platform: PlatformContext,
  name: Name,
  builtIn: NonNullable<PlatformHooks[Name]>,
): NonNullable<PlatformHooks[Name]> | undefined {
  const { hooks } = platform;
  if (hooks === undefined) return builtIn;
  const capability = HOOK_CAPABILITY[name];
  if (!hasCapability(platform, capability)) return undefined;
  const hook = hooks[name];
  if (hook === undefined) {
    throw new Error(
      `The installed eve host declares the "${capability}" capability but has no ${name} hook. Add hooks.${name}, or stop declaring "${capability}".`,
    );
  }
  return (hook as (...args: never[]) => unknown).bind(hooks) as NonNullable<PlatformHooks[Name]>;
}

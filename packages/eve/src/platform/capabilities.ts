import type { PlatformContext } from "#platform/context.js";

export interface HostCapabilityVersions {
  readonly "1": {
    readonly hostedSandbox?: boolean;
    readonly sandboxCredentialTransforms?: boolean;
    readonly stopsSandboxesOnExit?: boolean;
    readonly agentRuns?: boolean;
  };
}

export type HostCapabilityName = keyof HostCapabilityVersions["1"];

export type HostCapabilities = { readonly [Name in HostCapabilityName]: boolean };

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
    hostedSandbox: options.hostedSandbox === true,
    sandboxCredentialTransforms: options.sandboxCredentialTransforms === true,
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

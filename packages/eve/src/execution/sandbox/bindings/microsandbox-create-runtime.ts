import { createMicrosandboxWithProgress } from "#execution/sandbox/bindings/microsandbox-create.js";
import { applyMicrosandboxNetwork } from "#execution/sandbox/bindings/microsandbox-network.js";
import type { ResolvedMicrosandboxOptions } from "#execution/sandbox/bindings/microsandbox-options.js";
import { withDevelopmentSandboxTags } from "#execution/sandbox/development-run.js";
import type { SandboxBackendTags } from "#public/definitions/sandbox-backend.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { Sandbox as MicrosandboxSandbox } from "microsandbox";

export type MicrosandboxModule = typeof import("microsandbox");

export async function createMicrosandbox(input: {
  readonly fromSnapshot?: string;
  readonly log?: (message: string) => void;
  readonly module: MicrosandboxModule;
  readonly name: string;
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly options: ResolvedMicrosandboxOptions;
  readonly ports: ResolvedMicrosandboxOptions["ports"];
  readonly tags?: SandboxBackendTags;
  readonly user?: string;
  readonly workdir: string;
}): Promise<MicrosandboxSandbox> {
  let builder = input.module.Sandbox.builder(input.name)
    .cpus(input.options.cpus)
    .detached(true)
    .envs(input.options.env)
    .labels(resolveMicrosandboxLabels(input.tags))
    .memory(input.options.memoryMiB)
    .pullPolicy(input.options.pullPolicy)
    .replace()
    .workdir(input.workdir);

  builder =
    input.fromSnapshot === undefined
      ? builder.image(input.options.image)
      : builder.fromSnapshot(input.fromSnapshot);

  if (input.user !== undefined) {
    builder = builder.user(input.user);
  }

  builder = applyMicrosandboxNetwork(
    builder,
    input.networkPolicy,
    input.ports.map((mapping) => mapping.sandboxPort),
  );
  for (const mapping of input.ports) {
    builder = builder.portBind("127.0.0.1", mapping.hostPort, mapping.sandboxPort);
  }

  return await createMicrosandboxWithProgress({
    builder,
    errorType: input.module.MicrosandboxError,
    log: input.log,
    source:
      input.fromSnapshot === undefined
        ? `image "${input.options.image}"`
        : `snapshot "${input.fromSnapshot}"`,
  });
}

function resolveMicrosandboxLabels(tags: SandboxBackendTags | undefined): Record<string, string> {
  return {
    "eve.backend": "microsandbox",
    ...withDevelopmentSandboxTags(tags),
  };
}

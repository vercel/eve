import { getVercelSandboxFetch } from "#execution/sandbox/bindings/vercel-credentials.js";
import type { VercelModule, VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-options.js";

export type VercelSandboxCreateParams = VercelCreateOptions & {
  readonly name: string;
  readonly persistent: boolean;
} & VercelSandboxInternalCreateOptions;

type VercelSandboxInternalCreateOptions = {
  readonly [key: `__${string}`]: unknown;
};

export type CreateVercelSandbox = (input: {
  readonly createOptions: VercelSandboxCreateParams;
  readonly sandboxModule: VercelModule;
}) => Promise<VercelSandbox>;

export async function createVercelEveImageSandbox(input: {
  readonly createOptions: VercelSandboxCreateParams;
  readonly sandboxModule: VercelModule;
}): Promise<VercelSandbox> {
  const { image, runtime: _runtime, source, ...createOptions } = input.createOptions;
  const fetch = getVercelSandboxFetch(input.createOptions);

  /*
   * `runtime`, `image`, and a snapshot source are mutually exclusive in the
   * SDK.
   */
  if (source?.type === "snapshot") {
    return await input.sandboxModule.Sandbox.create({
      ...createOptions,
      source,
      fetch,
    });
  }
  return await input.sandboxModule.Sandbox.create({
    ...createOptions,
    source,
    image: image ?? VERCEL_EVE_SANDBOX_IMAGE,
    fetch,
  });
}

const VERCEL_EVE_SANDBOX_IMAGE = "vercel/eve:latest";

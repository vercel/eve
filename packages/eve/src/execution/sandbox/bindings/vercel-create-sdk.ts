import {
  getVercelSandboxFetch,
  resolveVercelSandboxCredentials,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { VERCEL_EVE_SANDBOX_IMAGE } from "#execution/sandbox/bindings/eve-image.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

export type VercelSandboxCreateParams = VercelCreateOptions & {
  readonly name: string;
  readonly persistent: boolean;
  readonly source?: VercelCreateOptions["source"];
  tags?: Record<string, string> | undefined;
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
  const options = {
    ...createOptions,
    ...(await resolveVercelSandboxCredentials(input.createOptions)),
    fetch: getVercelSandboxFetch(input.createOptions),
  };

  /*
   * `runtime`, `image`, and a snapshot source are mutually exclusive in the
   * SDK.
   */
  if (source?.type === "snapshot") {
    return await input.sandboxModule.Sandbox.create({ ...options, source });
  }
  return await input.sandboxModule.Sandbox.create({
    ...options,
    source,
    image: image ?? VERCEL_EVE_SANDBOX_IMAGE,
  });
}

import type * as VercelSandboxSdk from "#compiled/@vercel/sandbox/index.js";
import type { Sandbox as SdkSandbox } from "#compiled/@vercel/sandbox/index.js";
import type { VercelSdkCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";

export type VercelSandboxModule = typeof VercelSandboxSdk;

export type VercelSandboxCreateParams = VercelSdkCreateOptions & {
  readonly name: string;
  readonly persistent: boolean;
  readonly source?: VercelSdkCreateOptions["source"];
  tags?: Record<string, string> | undefined;
} & VercelSandboxInternalCreateOptions;

type VercelSandboxInternalCreateOptions = {
  readonly [key: `__${string}`]: unknown;
};

export type CreateVercelSandbox = (input: {
  readonly createOptions: VercelSandboxCreateParams;
  readonly sandboxModule: VercelSandboxModule;
}) => Promise<SdkSandbox>;

export async function createVercelEveImageSandbox(input: {
  readonly createOptions: VercelSandboxCreateParams;
  readonly sandboxModule: VercelSandboxModule;
}): Promise<SdkSandbox> {
  const createOptions: VercelSandboxCreateParams = {
    ...input.createOptions,
    __image: VERCEL_EVE_SANDBOX_IMAGE,
  };
  return await input.sandboxModule.Sandbox.create(createOptions);
}

const VERCEL_EVE_SANDBOX_IMAGE = "vercel/eve:latest";

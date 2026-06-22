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
  const createOptions: VercelSandboxCreateParams = {
    ...input.createOptions,
    __image: VERCEL_EVE_SANDBOX_IMAGE,
  };
  return await input.sandboxModule.Sandbox.create(createOptions);
}

const VERCEL_EVE_SANDBOX_IMAGE = "vercel/eve:latest";

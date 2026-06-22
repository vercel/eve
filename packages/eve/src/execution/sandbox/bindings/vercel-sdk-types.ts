import type { Sandbox as VercelSdkSandbox } from "#compiled/@vercel/sandbox/index.js";

export type VercelSdkCreateOptions = NonNullable<Parameters<typeof VercelSdkSandbox.create>[0]>;

export type VercelSdkGetOptions = Parameters<typeof VercelSdkSandbox.get>[0];

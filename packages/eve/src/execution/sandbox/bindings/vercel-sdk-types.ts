import type * as VercelSdk from "#compiled/@vercel/sandbox/index.js";

export type VercelSdkCommand = VercelSdk.Command;

export type VercelSdkCreateOptions = NonNullable<Parameters<typeof VercelSdk.Sandbox.create>[0]>;

export type VercelSdkGetOptions = Parameters<typeof VercelSdk.Sandbox.get>[0];

export type VercelSdkModule = typeof VercelSdk;

export type VercelSdkSandbox = VercelSdk.Sandbox;

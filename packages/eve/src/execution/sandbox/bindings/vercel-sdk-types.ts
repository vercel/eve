import type * as Vercel from "#compiled/@vercel/sandbox/index.js";
import type * as VercelDelete from "#compiled/@vercel/sandbox-delete/index.js";

export type VercelCreateOptions = NonNullable<Parameters<typeof Vercel.Sandbox.create>[0]>;

export type VercelGetOptions = Parameters<typeof Vercel.Sandbox.get>[0];

export type VercelModule = typeof Vercel;

export type VercelSandbox = Vercel.Sandbox;

export type VercelSandboxUser = ReturnType<VercelSandbox["asUser"]>;

export type VercelDeleteGetOptions = Parameters<typeof VercelDelete.Sandbox.get>[0];

export type VercelDeleteModule = typeof VercelDelete;

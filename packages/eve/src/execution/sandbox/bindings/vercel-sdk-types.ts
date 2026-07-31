import type * as Vercel from "#compiled/@vercel/sandbox/index.js";

export type VercelGetOptions = Parameters<typeof Vercel.Sandbox.get>[0];

export type VercelModule = typeof Vercel;

export type VercelSandbox = Vercel.Sandbox;

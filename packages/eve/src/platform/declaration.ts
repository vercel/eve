import type { DurableEngine } from "#execution/durable.js";
import type {
  Build,
  Compute,
  Deployment,
  Identity,
  ModelCredentials,
  Network,
  PlatformApp,
  Storage,
  Telemetry,
  Triggers,
} from "#platform/entities.js";

export interface PlatformFields<Context> {
  context?(): Context | Promise<Context>;
  deployment(app: PlatformApp, context: Context): Deployment;
  durable?(): DurableEngine<Context>;
  triggers?(app: PlatformApp, context: Context): Triggers;
  compute?(app: PlatformApp, context: Context): Compute;
  storage?(app: PlatformApp, context: Context): Storage;
  identity?(app: PlatformApp, context: Context): Identity;
  network?(app: PlatformApp, context: Context): Network;
  telemetry?(app: PlatformApp, context: Context): Telemetry;
  models?(app: PlatformApp, context: Context): ModelCredentials;
  build?: Build;
}

const DECLARATION: unique symbol = Symbol.for("eve.platform-declaration");

export type PlatformDeclaration<Context = undefined> = Readonly<PlatformFields<Context>> & {
  readonly [DECLARATION]: true;
};

export function definePlatform<Context = undefined>(
  fields: PlatformFields<Context>,
): PlatformDeclaration<Context> {
  return Object.freeze({ ...fields, [DECLARATION]: true as const });
}

export function isPlatformDeclaration(value: unknown): value is PlatformDeclaration<unknown> {
  return typeof value === "object" && value !== null && Object.hasOwn(value, DECLARATION);
}

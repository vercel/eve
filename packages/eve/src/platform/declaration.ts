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

type Factory<Entity, Context> = (app: PlatformApp, context: Context) => Entity;

export interface PlatformFields<Context> {
  context?(): Context | Promise<Context>;
  deployment: Factory<Deployment, Context>;
  triggers?: Factory<Triggers, Context>;
  compute?: Factory<Compute, Context>;
  storage?: Factory<Storage, Context>;
  identity?: Factory<Identity, Context>;
  network?: Factory<Network, Context>;
  telemetry?: Factory<Telemetry, Context>;
  models?: Factory<ModelCredentials, Context>;
  build?: Build;
}

const DECLARATION: unique symbol = Symbol("eve platform declaration");

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

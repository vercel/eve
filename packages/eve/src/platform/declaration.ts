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

/**
 * The fields of a platform declaration. Each field except `context`, `durable`, and `build` is a
 * factory for one entity. eve calls the factories when the app boots, with the app and the value
 * of `context()`.
 */
export interface PlatformFields<Context> {
  /** Returns the values that exist only at run time. eve calls it one time for each app. */
  context?(): Context | Promise<Context>;
  /** Makes the deployment entity. Each platform gives it. */
  deployment(app: PlatformApp, context: Context): Deployment;
  /**
   * Returns the durable engine that runs sessions. It takes no context, opens no resource, and the
   * build reads its `build`. Without it, eve runs the Workflow engine with the World from
   * `agent.ts` or the local World.
   */
  durable?(): DurableEngine<Context>;
  /** Makes the service that keeps and fires dynamic schedules. */
  triggers?(app: PlatformApp, context: Context): Triggers;
  /** Makes the hosted sandbox where untrusted code runs. */
  compute?(app: PlatformApp, context: Context): Compute;
  /** Makes the storage of memory documents. */
  storage?(app: PlatformApp, context: Context): Storage;
  /** Makes the checks of callers that come in. */
  identity?(app: PlatformApp, context: Context): Identity;
  /** Makes the calls that go out to this deployment and other services. */
  network?(app: PlatformApp, context: Context): Network;
  /** Makes the destination of traces. */
  telemetry?(app: PlatformApp, context: Context): Telemetry;
  /** Makes the source of model credentials in development. */
  models?(app: PlatformApp, context: Context): ModelCredentials;
  /** The packaging of the application. The build reads it and never calls a factory. */
  build?: Build;
}

const DECLARATION: unique symbol = Symbol.for("eve.platform-declaration");

/** A platform declaration from {@link definePlatform}, the default export of `agent/platform.ts`. */
export type PlatformDeclaration<Context = undefined> = Readonly<PlatformFields<Context>> & {
  readonly [DECLARATION]: true;
};

/**
 * Declares the platform that the application runs on. Export the result as the default export of
 * `agent/platform.ts`. Without that file, eve uses its built-in Vercel platform.
 */
export function definePlatform<Context = undefined>(
  fields: PlatformFields<Context>,
): PlatformDeclaration<Context> {
  return Object.freeze({ ...fields, [DECLARATION]: true as const });
}

export function isPlatformDeclaration(value: unknown): value is PlatformDeclaration<unknown> {
  return typeof value === "object" && value !== null && Object.hasOwn(value, DECLARATION);
}

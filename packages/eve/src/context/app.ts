import { ContextContainer, contextStorage } from "#context/container.js";
import type { ContextAccessor, ContextReader } from "#context/key.js";
import { AppKey } from "#context/keys.js";
import type { Entities } from "#platform/entities.js";
import { selectedProcessPlatformNow } from "#platform/process.js";
import { stepApp, type App } from "#runtime/app.js";

export { AppKey } from "#context/keys.js";

export function appOf(ctx: ContextReader | undefined): App | undefined {
  return ctx?.get(AppKey);
}

export function currentApp(): App {
  return requireApp(contextStorage.getStore());
}

export function requireApp(ctx: ContextReader | undefined): App {
  const app = appOf(ctx) ?? stepApp();
  if (app === undefined) {
    throw new Error(
      "eve read the app outside of a request, a turn, or a step. Call this code from a channel handler, a tool, a hook, or a step that eve runs, or pass the app to it.",
    );
  }
  return app;
}

export function ambientPlatform(): Entities | undefined {
  return (appOf(contextStorage.getStore()) ?? stepApp())?.platform ?? selectedProcessPlatformNow();
}

export function bindApp(ctx: ContextAccessor, app: App): void {
  ctx.set(AppKey, app);
}

export function runInApp<T>(app: App, fn: () => T): T {
  const ctx = new ContextContainer();
  bindApp(ctx, app);
  return contextStorage.run(ctx, fn);
}

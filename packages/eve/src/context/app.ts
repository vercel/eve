import { ContextKey, type ContextAccessor, type ContextReader } from "#context/key.js";
import type { App } from "#runtime/app.js";

export const AppKey = new ContextKey<App>("eve.app");

export function appOf(ctx: ContextReader | undefined): App | undefined {
  return ctx?.get(AppKey);
}

export function bindApp(ctx: ContextAccessor, app: App | undefined): void {
  if (app !== undefined) ctx.set(AppKey, app);
}

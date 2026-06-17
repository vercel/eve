import { randomBytes } from "node:crypto";

import type { Nitro } from "nitro/types";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

/**
 * Builds an unguessable route path for eve's Vercel cron handler.
 *
 * Vercel cron jobs hit a single configurable path (default `/_vercel/cron`)
 * for every scheduled tick, identifying the schedule via the
 * `x-vercel-cron-schedule` header. The default path is publicly known and
 * relies on the user setting a `CRON_SECRET` env var to authenticate
 * incoming requests.
 *
 * eve sidesteps the manual env var by giving each build a unique random
 * handler path under the framework's protocol prefix — the path itself is
 * the secret. Vercel's cron infra reads the path from the deploy's
 * `config.crons[]` so the platform always knows where to POST, and the same
 * path is registered as a Nitro route handler in the function. The path is
 * never logged, exposed in HTTP responses, or persisted, so it is
 * unguessable to anyone without access to the deploy's build artifacts.
 *
 * If `CRON_SECRET` is also set, Nitro's preset will additionally validate
 * the `Authorization` header — the unguessable path replaces a required
 * `CRON_SECRET` and acts as defense in depth when both are configured.
 */
export function createEveCronHandlerRoute(): string {
  const token = randomBytes(32).toString("base64url");
  return `${EVE_ROUTE_PREFIX}/cron/${token}`;
}

/**
 * Applies eve's unguessable cron handler route to a Nitro instance built
 * with the Vercel preset.
 *
 * The Vercel preset reads `nitro.options.vercel.cronHandlerRoute` at two
 * later moments in the build:
 *   - the `build:before` hook registers the Nitro handler at that path,
 *   - the build output writer emits `config.crons[].path` from the same
 *     value.
 *
 * Both reads happen after `createNitro()` returns, so a one-time mutation
 * before the first build hook fires keeps the handler and the published
 * cron path in sync.
 *
 * No-op for non-Vercel presets, which never populate
 * `nitro.options.vercel`.
 */
export function applyEveCronHandlerRoute(nitro: Nitro): void {
  if (nitro.options.vercel === undefined) {
    return;
  }

  nitro.options.vercel.cronHandlerRoute = createEveCronHandlerRoute();
}

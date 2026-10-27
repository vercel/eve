import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";
import type {
  BoardClient,
  BoardDiscovery,
  BoardRegistration,
  BoardRegistrationInput,
} from "#public/channels/board/client.js";

/** The board wakes a registrant at `<base>/wake`, so the route is this base plus `/wake`. */
export const BOARD_ROUTE_BASE = "/eve/v1/board";
export const BOARD_WAKE_ROUTE = `${BOARD_ROUTE_BASE}/wake`;

/** The environment variables registration reads. */
type Env = Readonly<Record<string, string | undefined>>;

/** What eve registers: one watcher, named by the profile eve writes as. */
export interface BoardWatcherConfig {
  readonly tail: string;
  readonly when: "matches" | "enters";
  readonly profile: string;
  readonly previews: boolean;
}

/** A board route as the public sees it, under `EVE_PUBLIC_ROUTE_PREFIX` when one is set. */
export function publicBoardRoute(route: string, env: Env = process.env): string {
  return joinEveRoutePath(
    normalizePublicRoutePrefix(env[EVE_PUBLIC_ROUTE_PREFIX_ENV]) ?? "",
    route,
  );
}

/**
 * Whether a request reached this deployment on the host the board wakes: production's domain,
 * or a preview's branch URL. Those always route to the current deployment, while an older
 * deployment is reachable only on its own URL, so only these requests may replace the
 * registration.
 */
export function reachedOnWakeHost(request: Request, env: Env = process.env): boolean {
  const environment = hostedEnvironment(env);
  const expected =
    environment === "production"
      ? env.VERCEL_PROJECT_PRODUCTION_URL
      : environment === "preview"
        ? env.VERCEL_BRANCH_URL
        : undefined;
  return (
    expected !== undefined && new URL(request.url).host.toLowerCase() === expected.toLowerCase()
  );
}

/** The Vercel environment a deployment runs in, or `undefined` outside a hosted deployment. */
export function hostedEnvironment(env: Env = process.env): "production" | "preview" | undefined {
  const target = env.VERCEL_ENV;
  return target === "production" || target === "preview" ? target : undefined;
}

/**
 * The registration this deployment should hold, or `undefined` when it shouldn't register
 * (a preview without `previews`). Outside a hosted deployment eve pulls on its own, so it
 * registers no wake target.
 */
export function desiredRegistration(
  watcher: BoardWatcherConfig,
  discovery: Pick<BoardDiscovery, "wake_by_path">,
  env: Env = process.env,
): BoardRegistrationInput | undefined {
  const watch = { [watcher.profile]: { tail: watcher.tail, when: watcher.when } };
  const environment = hostedEnvironment(env);
  if (environment === undefined) return { url: null, watch };
  if (environment === "preview" && !watcher.previews) return undefined;

  const base = publicBoardRoute(BOARD_ROUTE_BASE, env);
  if (discovery.wake_by_path === true) {
    return {
      branch: environment === "preview" ? (env.VERCEL_GIT_COMMIT_REF ?? null) : null,
      path: base,
      url: null,
      watch,
    };
  }
  const host =
    environment === "preview" ? env.VERCEL_BRANCH_URL : env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host) {
    throw new Error(
      `The board doesn't wake by path, and ${environment === "preview" ? "VERCEL_BRANCH_URL" : "VERCEL_PROJECT_PRODUCTION_URL"} is unset, so eve has no URL to register.`,
    );
  }
  return { url: `https://${host}${base}`, watch };
}

/** Whether the board's registration already says what `desired` says. */
export function sameRegistration(
  held: BoardRegistrationInput,
  desired: BoardRegistrationInput,
): boolean {
  if ((held.url ?? null) !== (desired.url ?? null)) return false;
  if ((held.path ?? null) !== (desired.path ?? null)) return false;
  if ((held.branch ?? null) !== (desired.branch ?? null)) return false;
  const heldNames = Object.keys(held.watch).sort();
  const desiredNames = Object.keys(desired.watch).sort();
  if (heldNames.join("\n") !== desiredNames.join("\n")) return false;
  return desiredNames.every((name) => {
    const a = held.watch[name]!;
    const b = desired.watch[name]!;
    return a.tail === b.tail && a.when === b.when;
  });
}

/**
 * Brings the board's registration in line with this deployment's config. With `overwrite: false`
 * it only registers when there's none: older deployments keep cold-starting while their runs
 * finish, and must not put an old tail back. Only a request that reached the current deployment
 * replaces a registration that differs.
 */
export async function reconcileRegistration(input: {
  readonly client: BoardClient;
  readonly watcher: BoardWatcherConfig;
  readonly overwrite: boolean;
  readonly env?: Env;
}): Promise<"registered" | "unchanged" | "skipped"> {
  const { client } = input;
  const desired = desiredRegistration(input.watcher, await client.discovery(), input.env);
  if (desired === undefined) return "skipped";
  const held = await heldRegistration(client);
  if (held !== undefined) {
    if (sameRegistration(held, desired)) return "unchanged";
    if (!input.overwrite) return "skipped";
  }
  await client.register(desired);
  return "registered";
}

// `GET /watchers` lists every registration for a caller with `manage` everywhere, so pick ours.
async function heldRegistration(client: BoardClient): Promise<BoardRegistration | undefined> {
  const [me, registrations] = await Promise.all([client.me(), client.watchers()]);
  return registrations.find((registration) => registration.owner === me.principal);
}

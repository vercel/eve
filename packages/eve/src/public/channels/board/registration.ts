import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";
import {
  boardErrorCode,
  type BoardClient,
  type BoardDiscovery,
  type BoardRegistration,
  type BoardRegistrationInput,
} from "#public/channels/board/client.js";

export const BOARD_ROUTE_BASE = "/eve/v1/board";
export const BOARD_WAKE_ROUTE = `${BOARD_ROUTE_BASE}/wake`;

type Env = Readonly<Record<string, string | undefined>>;

export interface BoardWatcherConfig {
  readonly watchers: Readonly<Record<string, { readonly tail: string }>>;
  readonly previews: boolean;
}

export function publicBoardRoute(route: string, env: Env = process.env): string {
  return joinEveRoutePath(
    normalizePublicRoutePrefix(env[EVE_PUBLIC_ROUTE_PREFIX_ENV]) ?? "",
    route,
  );
}

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

export function hostedEnvironment(env: Env = process.env): "production" | "preview" | undefined {
  const target = env.VERCEL_ENV;
  return target === "production" || target === "preview" ? target : undefined;
}

export function desiredRegistration(
  watcher: BoardWatcherConfig,
  discovery: Pick<BoardDiscovery, "wake_by_path">,
  env: Env = process.env,
): BoardRegistrationInput | undefined {
  const watch = Object.fromEntries(
    Object.entries(watcher.watchers).map(([name, { tail }]) => [name, { tail }]),
  );
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
  return desiredNames.every((name) => held.watch[name]!.tail === desired.watch[name]!.tail);
}

export async function reconcileRegistration(input: {
  readonly client: BoardClient;
  readonly watcher: BoardWatcherConfig;
  readonly overwrite: boolean;
  readonly env?: Env;
}): Promise<"registered" | "unchanged" | "skipped"> {
  const { client } = input;
  try {
    const desired = desiredRegistration(input.watcher, await client.discovery(), input.env);
    if (desired === undefined) return "skipped";
    const held = await heldRegistration(client);
    if (held !== undefined) {
      if (sameRegistration(held, desired)) return "unchanged";
      if (!input.overwrite) return "skipped";
    }
    await client.register(desired);
    return "registered";
  } catch (error) {
    if (boardErrorCode(error) !== "watchers_need_project") throw error;
    throw new Error(
      "Vercel's board takes watchers only from a deployment, so eve can't register them as you. To develop locally, run `npx @vercel/board serve` and set BOARD_URL to the URL it prints; to try the hosted board, deploy a preview with `previews: true`.",
      { cause: error },
    );
  }
}

async function heldRegistration(client: BoardClient): Promise<BoardRegistration | undefined> {
  const [me, registrations] = await Promise.all([client.me(), client.watchers()]);
  return registrations.find((registration) => registration.owner === me.principal);
}

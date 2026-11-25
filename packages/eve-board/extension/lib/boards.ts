import type { BoardAuthorize } from "./authorize.ts";
import type { BoardCan, BoardSettings } from "./client.ts";
import { normalizeBoardRouteBase } from "./route.ts";

export const DEFAULT_BOARD_KEY = "default";
export const DEFAULT_WATCH_CHANNEL = "eve-config/watches";

export interface ResolvedBoardConfig {
  readonly key: string;
  readonly shorthand: boolean;
  readonly name?: string;
  readonly team?: string;
  readonly url?: string;
  readonly profile?: string;
  readonly can?: BoardCan;
  readonly watchChannel: string;
  readonly authorize?: BoardAuthorize;
  readonly routeBase: string;
  readonly registrationRouteBase: string;
}

export interface ResolvedBoardSet {
  readonly shorthand: boolean;
  readonly routeBase: string;
  readonly byKey: ReadonlyMap<string, ResolvedBoardConfig>;
  readonly keys: readonly string[];
}

export function resolveBoards(settings: BoardSettings): ResolvedBoardSet {
  const routeBase = normalizeBoardRouteBase(settings.route);
  if (settings.boards === undefined) {
    const entry: ResolvedBoardConfig = {
      authorize: settings.authorize,
      can: settings.can,
      key: DEFAULT_BOARD_KEY,
      name: settings.name,
      profile: settings.profile,
      registrationRouteBase: routeBase,
      routeBase,
      shorthand: true,
      team: settings.team,
      url: settings.url,
      watchChannel: settings.watchChannel ?? DEFAULT_WATCH_CHANNEL,
    };
    return {
      byKey: new Map([[DEFAULT_BOARD_KEY, entry]]),
      keys: [DEFAULT_BOARD_KEY],
      routeBase,
      shorthand: true,
    };
  }

  const byKey = new Map<string, ResolvedBoardConfig>();
  const keys: string[] = [];
  for (const [key, entry] of Object.entries(settings.boards)) {
    byKey.set(key, {
      authorize: entry.authorize ?? settings.authorize,
      can: entry.can,
      key,
      name: entry.name,
      profile: entry.profile ?? settings.profile,
      registrationRouteBase: `${routeBase}/${key}`,
      routeBase,
      shorthand: false,
      team: entry.team,
      url: entry.url,
      watchChannel: entry.watchChannel ?? settings.watchChannel ?? DEFAULT_WATCH_CHANNEL,
    });
    keys.push(key);
  }
  if (keys.length === 0) {
    throw new Error("Board extension `boards` must configure at least one board.");
  }
  return { byKey, keys, routeBase, shorthand: false };
}

export function lookupBoard(set: ResolvedBoardSet, key: string): ResolvedBoardConfig | undefined {
  return set.byKey.get(key);
}

export function selectBoard(
  set: ResolvedBoardSet,
  requestedKey: string | undefined,
  sessionKey?: string | null,
): ResolvedBoardConfig {
  if (requestedKey !== undefined) {
    const found = lookupBoard(set, requestedKey);
    if (found !== undefined) return found;
    throw new Error(`Unknown board "${requestedKey}". Configured boards: ${set.keys.join(", ")}.`);
  }
  if (sessionKey != null && sessionKey.length > 0) {
    const found = lookupBoard(set, sessionKey);
    if (found !== undefined) return found;
    throw new Error(
      `Board "${sessionKey}" from this session is no longer configured. Configured boards: ${set.keys.join(", ")}.`,
    );
  }
  if (set.byKey.size === 1) {
    return set.byKey.values().next().value!;
  }
  throw new Error(
    `Pass \`board\` to choose which board to use. Configured boards: ${set.keys.join(", ")}.`,
  );
}

export function resolveSessionBoard(
  settings: BoardSettings,
  sessionKey?: string | null,
): ResolvedBoardConfig {
  const set = resolveBoards(settings);
  if (sessionKey != null && sessionKey.length > 0) {
    const found = lookupBoard(set, sessionKey);
    if (found !== undefined) return found;
    throw new Error(
      `Board "${sessionKey}" from this session is no longer configured. Configured boards: ${set.keys.join(", ")}.`,
    );
  }
  if (set.byKey.size === 1) {
    return set.byKey.values().next().value!;
  }
  throw new Error(
    `This board session has no board key, and multiple boards are configured (${set.keys.join(", ")}).`,
  );
}

export function formatConfiguredBoards(settings: BoardSettings): string | null {
  const set = resolveBoards(settings);
  if (set.shorthand) return null;
  const lines = [...set.byKey.values()].map((entry) => {
    const label = entry.name ?? "team default board";
    const team = entry.team === undefined ? "" : ` (team \`${entry.team}\`)`;
    return `- \`${entry.key}\`: ${label}${team}`;
  });
  const requirement =
    set.keys.length > 1
      ? "Outside a board session, pass `board` with one of the keys above to choose which board to use (except `watches`, which lists every board when `board` is omitted)."
      : `Pass \`board: "${set.keys[0]}"\` or leave \`board\` out to use it.`;
  return [
    "## Configured boards",
    "",
    ...lines,
    "",
    `In a session a board started, replies stay on that board and board tools default to that board. ${requirement}`,
  ].join("\n");
}

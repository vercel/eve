import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * What an agent may do by repository visibility.
 *
 * - `"private-write"`: public repositories are read-only; private and internal ones are read-write.
 * - `"public-write"`: public repositories are read-write; private and internal ones are refused.
 *
 * With `"app"`, both values need `github.permissions`, and it may write only the permissions in `WRITABLE_PERMISSIONS`.
 */
export type GitHubAccess = "private-write" | "public-write";

type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const PAGE_SIZE = 100;
/** An installation larger than this many pages (3,000 repositories) is refused, not sampled. */
const MAX_PAGES = 30;
const REQUEST_TIMEOUT_MS = 10_000;
/** Most lookups in flight at once; GitHub limits a token to 100 concurrent requests. */
const MAX_CONCURRENT_REQUESTS = 32;

const visibilitySchema = z.enum(["public", "private", "internal"]);
const repositorySchema = z.object({ visibility: visibilitySchema });
const installationsSchema = z.object({
  total_count: z.number(),
  installations: z.array(
    z.object({
      account: z.object({ login: z.string() }).nullish(),
      id: z.number(),
      permissions: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
const installationRepositoriesSchema = z.object({
  total_count: z.number(),
  repositories: z.array(z.object({ full_name: z.string(), visibility: visibilitySchema })),
});

/**
 * Permissions `"private-write"` lets a token write. Any other `write` or
 * `admin` permission can reach a public repository without naming one:
 * `administration` makes a private repository public or creates a public one,
 * and `repository_creation` creates repositories.
 */
const WRITABLE_PERMISSIONS: ReadonlySet<string> = new Set([
  "actions",
  "checks",
  "contents",
  "issues",
  "pull_requests",
  "statuses",
  "workflows",
]);

/** Permissions GitHub defines no `read` level for; a read-only token can't carry them. */
const WITHOUT_READ_LEVEL: ReadonlySet<string> = new Set(["workflows"]);

const PERMISSION_ENTRY = /^([a-z_]+)(?::(read|write|admin))?$/u;

interface ParsedPermission {
  readonly entry: string;
  readonly name: string;
  /** A bare name such as `"contents"` is `write`. */
  readonly level: string;
}

function writesOutsideAllowlist(permissions: Iterable<readonly [string, string]>): string[] {
  return [...permissions]
    .filter(([name, level]) => level !== "read" && !WRITABLE_PERMISSIONS.has(name))
    .map(([name, level]) => `${name}:${level}`);
}

/** A GitHub API lookup the policy made, which GitHub answered with `status`. */
export class GitHubPolicyLookupError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`GitHub answered ${status} to ${path}, so the access policy could not check visibility.`);
    this.name = "GitHubPolicyLookupError";
    this.status = status;
  }
}

/** Why an App command that names no single repository is refused: visibility is judged per repository. */
export function repositoryRequiredMessage(access: GitHubAccess): string {
  return `access ${JSON.stringify(access)} judges each App command by repository visibility, so set repository to owner/name. An owner or no repository can't be checked.`;
}

/**
 * Decides the permissions an app token carries for `owner/name`, or refuses.
 * `mint` mints a token for that repository with the given permissions; the
 * lookup uses a `metadata:read` token, and nothing is cached between commands.
 */
export async function appTokenPermissions(options: {
  readonly access: GitHubAccess;
  readonly configured: readonly string[] | undefined;
  readonly fetch: GitHubFetch;
  readonly mint: (permissions: readonly string[]) => Promise<string>;
  readonly repository: string;
}): Promise<readonly string[] | undefined> {
  const { access, repository } = options;
  const permissions = checkedPermissions(access, options.configured);
  const lookupToken = await options.mint(["metadata:read"]);
  const { visibility } = repositorySchema.parse(
    await githubGet(options.fetch, lookupToken, `/repos/${repository}`),
  );
  if (access === "public-write") {
    if (visibility !== "public") {
      throw new Error(
        `access "public-write" refused ${repository}: it is ${visibility}, and this agent may only use public repositories. Use a public repository.`,
      );
    }
    return permissions.map(({ entry }) => entry);
  }
  return visibility === "public" ? readOnly(permissions) : permissions.map(({ entry }) => entry);
}

function checkedPermissions(
  access: GitHubAccess,
  configured: readonly string[] | undefined,
): readonly ParsedPermission[] {
  if (!configured) {
    throw new Error(
      `access ${JSON.stringify(access)} refused: github.permissions is not set, so the App token would carry every permission the App holds, including administration. List the permissions the agent needs.`,
    );
  }
  const parsed = configured.map((entry): ParsedPermission => {
    const match = PERMISSION_ENTRY.exec(entry);
    if (!match) {
      throw new Error(
        `access ${JSON.stringify(access)} refused: github.permissions entry ${JSON.stringify(entry)} is not a lowercase name or name:read, name:write or name:admin, so it can't be checked.`,
      );
    }
    return { entry, name: match[1]!, level: match[2] ?? "write" };
  });
  const outside = writesOutsideAllowlist(parsed.map(({ name, level }) => [name, level] as const));
  if (outside.length > 0) {
    throw new Error(
      `access ${JSON.stringify(access)} refused: github.permissions grants ${outside.join(", ")}, which can change a repository's visibility or create one. Allowed writes are ${[...WRITABLE_PERMISSIONS].join(", ")}.`,
    );
  }
  return parsed;
}

/** Installation checks that passed, by caller and access value, with the turn that ran each. */
export type InstallationChecksPassed = Readonly<Record<string, string>>;

/** Where passed checks are kept; the session's `defineState` handle in the shell. */
export interface InstallationCheckState {
  get(): InstallationChecksPassed;
  update(fn: (current: InstallationChecksPassed) => InstallationChecksPassed): void;
}

export interface InstallationCheckCache {
  readonly turnId: string;
  readonly state: InstallationCheckState;
}

/**
 * Refuses the command when the caller's App installation reaches a repository
 * the access setting rules out. A user token can't be narrowed when it is
 * minted, so the installation is the boundary. The check reads page 1 of each
 * list, then every remaining page at once, and stops at the first refused
 * repository. A passed check is kept in the session's state for the rest of
 * the turn that ran it; the next turn checks again. A refusal or a failed
 * lookup is never kept.
 */
export async function assertUserInstallation(options: {
  readonly access: GitHubAccess;
  readonly cache?: InstallationCheckCache;
  readonly fetch: GitHubFetch;
  readonly token: string;
}): Promise<void> {
  const { access, cache, token } = options;
  const key = `${access}:${createHash("sha256").update(token).digest("hex")}`;
  if (cache && cache.state.get()[key] === cache.turnId) return;
  const abort = new AbortController();
  const lookup: Lookup = {
    fetch: options.fetch,
    limit: createLimiter(MAX_CONCURRENT_REQUESTS),
    signal: abort.signal,
    token,
  };
  try {
    const installations = await readList(lookup, "/user/installations", (body) => {
      const { total_count, installations } = installationsSchema.parse(body);
      return { items: installations, total: total_count };
    });
    for (const installation of installations) {
      const outside = installation.permissions
        ? writesOutsideAllowlist(Object.entries(installation.permissions))
        : undefined;
      if (outside === undefined || outside.length > 0) {
        const label = installation.account?.login ?? String(installation.id);
        throw new Error(
          outside === undefined
            ? `access ${JSON.stringify(access)} refused: GitHub did not list the permissions of the App installation on ${label}.`
            : `access ${JSON.stringify(access)} refused: the App installation on ${label} grants ${outside.join(", ")}, which can change a repository's visibility or create one. Remove those permissions from the App.`,
        );
      }
    }
    await Promise.all(
      installations.map(({ id }) =>
        readList(
          lookup,
          `/user/installations/${id}/repositories`,
          (body) => {
            const { total_count, repositories } = installationRepositoriesSchema.parse(body);
            return { items: repositories, total: total_count };
          },
          (repositories) => {
            for (const repository of repositories) {
              if (access === "private-write" && repository.visibility === "public") {
                throw new Error(
                  `access "private-write" refused: the GitHub App installation includes a public repository (${repository.full_name}). Any user with read access can comment on a public repository, so narrow the App installation to private repositories.`,
                );
              }
              if (access === "public-write" && repository.visibility !== "public") {
                throw new Error(
                  `access "public-write" refused: the GitHub App installation includes a private or internal repository (${repository.full_name}). Narrow the App installation to public repositories.`,
                );
              }
            }
          },
        ),
      ),
    );
  } catch (error) {
    abort.abort();
    throw error;
  }
  cache?.state.update((current) => ({
    ...Object.fromEntries(Object.entries(current).filter(([, turnId]) => turnId === cache.turnId)),
    [key]: cache.turnId,
  }));
}

/** The read level of each permission; GitHub always grants `metadata:read`, so it stands in when none is left. */
function readOnly(permissions: readonly ParsedPermission[]): readonly string[] {
  const lowered = new Set(
    permissions
      .filter(({ name }) => !WITHOUT_READ_LEVEL.has(name))
      .map(({ name }) => `${name}:read`),
  );
  return lowered.size > 0 ? [...lowered] : ["metadata:read"];
}

interface Lookup {
  readonly fetch: GitHubFetch;
  readonly limit: <R>(run: () => Promise<R>) => Promise<R>;
  readonly signal: AbortSignal;
  readonly token: string;
}

/**
 * Reads every page of a list: page 1 first, which carries `total_count`, then
 * all remaining pages at once. `inspect` sees each page as it arrives, so a
 * refusal on page 1 wins over the size limit.
 */
async function readList<T>(
  lookup: Lookup,
  path: string,
  parse: (body: unknown) => { readonly items: T[]; readonly total: number },
  inspect: (items: T[]) => void = () => {},
): Promise<T[]> {
  const readPage = async (page: number) => {
    const result = parse(
      await lookup.limit(() => {
        lookup.signal.throwIfAborted();
        return githubGet(
          lookup.fetch,
          lookup.token,
          `${path}?per_page=${PAGE_SIZE}&page=${page}`,
          lookup.signal,
        );
      }),
    );
    inspect(result.items);
    return result;
  };
  const first = await readPage(1);
  const pages = Math.ceil(first.total / PAGE_SIZE);
  if (pages > MAX_PAGES) {
    throw new Error(
      `The access policy can't check ${path}: it lists more than ${MAX_PAGES * PAGE_SIZE} entries. Narrow the GitHub App installation.`,
    );
  }
  const rest = await Promise.all(
    Array.from({ length: Math.max(pages - 1, 0) }, (_, index) => readPage(index + 2)),
  );
  return [first, ...rest].flatMap((page) => page.items);
}

/** Runs at most `max` calls at once; a finished call hands its slot to the next waiting one. */
function createLimiter(max: number): Lookup["limit"] {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (run) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

async function githubGet(
  fetch: GitHubFetch,
  token: string,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "eve-git",
      "x-github-api-version": "2022-11-28",
    },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new GitHubPolicyLookupError(path.split("?")[0]!, response.status);
  return response.json();
}

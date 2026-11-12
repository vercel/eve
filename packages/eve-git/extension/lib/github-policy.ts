import { z } from "zod";

/**
 * What an agent may do by repository visibility.
 *
 * - `"private-write"`: public repositories are read-only; private and internal ones are read-write.
 *   Tokens may write only the permissions in `WRITABLE_PERMISSIONS`.
 * - `"public-write"`: public repositories are read-write; private and internal ones are refused.
 */
export type GitHubAccess = "private-write" | "public-write";

type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const PAGE_SIZE = 100;
/** An installation larger than this many pages (3,000 repositories) is refused, not sampled. */
const MAX_PAGES = 30;
const REQUEST_TIMEOUT_MS = 10_000;

const visibilitySchema = z.enum(["public", "private", "internal"]);
const repositorySchema = z.object({ visibility: visibilitySchema });
const installationsSchema = z.object({
  installations: z.array(
    z.object({
      account: z.object({ login: z.string() }).nullish(),
      id: z.number(),
      permissions: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
const installationRepositoriesSchema = z.object({
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
  const writable =
    access === "private-write" ? privateWritePermissions(options.configured) : undefined;
  const lookupToken = await options.mint(["metadata:read"]);
  const { visibility } = repositorySchema.parse(
    await githubGet(options.fetch, lookupToken, `/repos/${repository}`),
  );
  if (!writable) {
    if (visibility !== "public") {
      throw new Error(
        `access "public-write" refused ${repository}: it is ${visibility}, and this agent may only use public repositories. Use a public repository.`,
      );
    }
    return options.configured;
  }
  return visibility === "public" ? readOnly(writable) : writable;
}

function privateWritePermissions(configured: readonly string[] | undefined): readonly string[] {
  if (!configured) {
    throw new Error(
      `access "private-write" refused: github.permissions is not set, so the App token would carry every permission the App holds, including administration. List the permissions the agent needs.`,
    );
  }
  const outside = writesOutsideAllowlist(
    configured.map((permission) => {
      const [name = "", level = "write"] = permission.split(":");
      return [name, level] as const;
    }),
  );
  if (outside.length > 0) {
    throw new Error(
      `access "private-write" refused: github.permissions grants ${outside.join(", ")}, which can make a repository public or create one. Allowed writes are ${[...WRITABLE_PERMISSIONS].join(", ")}.`,
    );
  }
  return configured;
}

/**
 * Refuses the command when the caller's App installation reaches a repository
 * the access setting rules out. A user token can't be narrowed when it is
 * minted, so the installation is the boundary.
 */
export async function assertUserInstallation(options: {
  readonly access: GitHubAccess;
  readonly fetch: GitHubFetch;
  readonly token: string;
}): Promise<void> {
  const { access, token } = options;
  const installations = await githubPages(
    options.fetch,
    token,
    "/user/installations",
    (body) => installationsSchema.parse(body).installations,
  );
  if (access === "private-write") {
    for (const installation of installations) {
      const outside = installation.permissions
        ? writesOutsideAllowlist(Object.entries(installation.permissions))
        : undefined;
      if (outside === undefined || outside.length > 0) {
        const label = installation.account?.login ?? String(installation.id);
        throw new Error(
          outside === undefined
            ? `access "private-write" refused: GitHub did not list the permissions of the App installation on ${label}.`
            : `access "private-write" refused: the App installation on ${label} grants ${outside.join(", ")}, which can make a repository public or create one. Remove those permissions from the App.`,
        );
      }
    }
  }
  const offending: string[] = [];
  for (const { id } of installations) {
    const repositories = await githubPages(
      options.fetch,
      token,
      `/user/installations/${id}/repositories`,
      (body) => installationRepositoriesSchema.parse(body).repositories,
    );
    for (const repository of repositories) {
      const refused =
        access === "private-write"
          ? repository.visibility === "public"
          : repository.visibility !== "public";
      if (refused) offending.push(repository.full_name);
    }
  }
  if (offending.length === 0) return;
  const names = `${offending.slice(0, 10).join(", ")}${offending.length > 10 ? `, and ${offending.length - 10} more` : ""}`;
  throw new Error(
    access === "private-write"
      ? `access "private-write" refused: the GitHub App installation includes public repositories (${names}). Any user with read access can comment on a public repository, so narrow the App installation to private repositories.`
      : `access "public-write" refused: the GitHub App installation includes private or internal repositories (${names}). Narrow the App installation to public repositories.`,
  );
}

function readOnly(configured: readonly string[]): readonly string[] {
  return [
    ...new Set(configured.map((permission) => permission.replace(/:(?:write|admin)$/u, ":read"))),
  ];
}

async function githubPages<T>(
  fetch: GitHubFetch,
  token: string,
  path: string,
  items: (body: unknown) => T[],
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = items(
      await githubGet(fetch, token, `${path}?per_page=${PAGE_SIZE}&page=${page}`),
    );
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
  }
  throw new Error(
    `The access policy can't check ${path}: it lists more than ${MAX_PAGES * PAGE_SIZE} entries. Narrow the GitHub App installation.`,
  );
}

async function githubGet(fetch: GitHubFetch, token: string, path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "eve-git",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new GitHubPolicyLookupError(path.split("?")[0]!, response.status);
  return response.json();
}

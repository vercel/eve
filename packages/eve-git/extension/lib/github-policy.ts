import { z } from "zod";

/**
 * What an agent may do by repository visibility.
 *
 * - `"private-write"`: public repositories are read-only; private and internal ones are read-write.
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
const installationsSchema = z.object({ installations: z.array(z.object({ id: z.number() })) });
const installationRepositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      full_name: z.string(),
      permissions: z.object({ push: z.boolean() }).optional(),
      visibility: visibilitySchema,
    }),
  ),
});

/** A GitHub API lookup the policy made, which GitHub answered with `status`. */
export class GitHubPolicyLookupError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`GitHub answered ${status} to ${path}, so the access policy could not check visibility.`);
    this.name = "GitHubPolicyLookupError";
    this.status = status;
  }
}

/** Why a command that names no single repository is refused: visibility is judged per repository. */
export function repositoryRequiredMessage(access: GitHubAccess): string {
  return `access ${JSON.stringify(access)} judges each command by repository visibility, so set repository to owner/name. An owner or no repository can't be checked.`;
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
  const { access, configured, repository } = options;
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
    return configured;
  }
  return visibility === "public" ? readOnly(configured) : configured;
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
  const offending: string[] = [];
  for (const { id } of installations) {
    const repositories = await githubPages(
      options.fetch,
      token,
      `/user/installations/${id}/repositories`,
      (body) => installationRepositoriesSchema.parse(body).repositories,
    );
    for (const repository of repositories) {
      const writablePublic =
        repository.visibility === "public" && repository.permissions?.push === true;
      if (access === "private-write" ? writablePublic : repository.visibility !== "public") {
        offending.push(repository.full_name);
      }
    }
  }
  if (offending.length === 0) return;
  const names = `${offending.slice(0, 10).join(", ")}${offending.length > 10 ? `, and ${offending.length - 10} more` : ""}`;
  throw new Error(
    access === "private-write"
      ? `access "private-write" refused: the GitHub App installation includes public repositories the caller can write to (${names}). Narrow the App installation to private repositories.`
      : `access "public-write" refused: the GitHub App installation includes private or internal repositories (${names}). Narrow the App installation to public repositories.`,
  );
}

function readOnly(configured: readonly string[] | undefined): readonly string[] {
  if (!configured) return ["contents:read", "metadata:read"];
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

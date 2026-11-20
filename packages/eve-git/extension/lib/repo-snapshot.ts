import { getToken } from "@vercel/connect";
import type { rebuildSandboxTemplate, VercelSandboxSession } from "eve/sandbox/vercel";

import { shellQuote } from "./shell.ts";

/** Options for {@link refreshRepoSnapshot}. */
export interface RepoSnapshotOptions {
  /** Branch to track. Defaults to `main`. */
  readonly branch?: string;
  /** The Connect connector of a GitHub App installed on the repository's owner. */
  readonly connector: string;
  /** Where the repository is checked out in the sandbox, as a path from the workspace root or absolute. */
  readonly directory: string;
  /**
   * Installs dependencies in the rebuilt sandbox. It runs only when a lockfile changed between the
   * checkout and the new head, after GitHub access is set up. It may replace the sandbox's network
   * policy, for example to reach a private registry.
   */
  readonly install?: (sandbox: VercelSandboxSession) => Promise<void>;
  /** Files whose change triggers `install`. Defaults to the common JavaScript lockfiles. */
  readonly lockfiles?: readonly string[];
  /** The repository as `owner/name`. */
  readonly repository: string;
}

/** What {@link refreshRepoSnapshot} did. */
export interface RepoSnapshotResult {
  /** The branch head the template was compared with. */
  readonly head: string;
  /** `true` when new sessions now open from a template at `head`. */
  readonly rebuilt: boolean;
}

const DEFAULT_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

export interface RepoSnapshotDependencies {
  readonly fetch: typeof fetch;
  readonly getToken: typeof getToken;
  readonly rebuild: typeof rebuildSandboxTemplate;
}

export async function refresh(
  options: RepoSnapshotOptions,
  dependencies: RepoSnapshotDependencies,
): Promise<RepoSnapshotResult> {
  const token = await mintReadToken(options, dependencies.getToken);
  const head = await readBranchHead(options, token, dependencies.fetch);
  const { rebuilt } = await dependencies.rebuild({
    prepare: (sandbox) => checkoutHead(sandbox, options, token, head),
    revision: head,
  });
  return { head, rebuilt };
}

async function mintReadToken(
  options: RepoSnapshotOptions,
  getTokenFn: typeof getToken,
): Promise<string> {
  const [owner, name, ...rest] = options.repository.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Expected the repository as "owner/name", got "${options.repository}".`);
  }
  const token = await getTokenFn(options.connector, {
    authorizationDetails: [
      {
        type: "github_app_installation",
        org: owner,
        permissions: ["contents:read"],
        repositories: [name],
      },
    ],
    subject: { type: "app" },
  });
  if (!token)
    throw new Error(`Connect returned an empty token for ${JSON.stringify(options.connector)}.`);
  return token;
}

async function readBranchHead(
  options: RepoSnapshotOptions,
  token: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const branch = options.branch ?? "main";
  const response = await fetchFn(
    `https://api.github.com/repos/${options.repository}/commits/${branch.split("/").map(encodeURIComponent).join("/")}`,
    {
      headers: {
        accept: "application/vnd.github.sha",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub returned ${response.status} for the head of ${options.repository}@${branch}.`,
    );
  }
  const head = (await response.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(
      `GitHub returned "${head}" for the head of ${options.repository}@${branch}, not a commit sha.`,
    );
  }
  return head;
}

async function checkoutHead(
  sandbox: VercelSandboxSession,
  options: RepoSnapshotOptions,
  token: string,
  head: string,
): Promise<void> {
  await sandbox.setNetworkPolicy({
    allow: {
      "github.com": [
        {
          transform: [
            {
              headers: {
                authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
              },
            },
          ],
        },
      ],
      "*": [],
    },
  });
  const lockfiles = (options.lockfiles ?? DEFAULT_LOCKFILES).map(shellQuote).join(" ");
  const result = await sandbox.run({
    command: [
      "set -e",
      "previous=$(git rev-parse HEAD)",
      `git fetch --no-tags ${shellQuote(`https://github.com/${options.repository}.git`)} ${shellQuote(head)}`,
      `git reset --hard ${shellQuote(head)}`,
      `test "$(git rev-parse HEAD)" = ${shellQuote(head)}`,
      `git diff --quiet "$previous" ${shellQuote(head)} -- ${lockfiles} || echo lockfile-changed`,
    ].join("\n"),
    env: { GIT_TERMINAL_PROMPT: "0" },
    workingDirectory: options.directory,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Fetching ${options.repository}@${head} in the sandbox failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  if (result.stdout.includes("lockfile-changed") && options.install !== undefined) {
    await options.install(sandbox);
  }
}

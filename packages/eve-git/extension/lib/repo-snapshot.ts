import type { rebuildSandboxTemplate, VercelSandboxSession } from "eve/sandbox/vercel";

import { createHash } from "node:crypto";

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
   * checkout and the new head, after the fetch. It runs with outbound network open and without the
   * GitHub token, and may replace the sandbox's network policy, for example to reach a private
   * registry. `sandbox.run()` does not throw on a nonzero exit code, so throw when `exitCode` is
   * not `0`: only a thrown error keeps the template as it was.
   */
  readonly install?: (sandbox: VercelSandboxSession) => Promise<void>;
  /**
   * Files whose change triggers `install`. Defaults to the common JavaScript lockfiles. An empty
   * list never runs `install`.
   */
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
  readonly getToken: (
    connector: string,
    params: {
      authorizationDetails: {
        type: "github_app_installation";
        org: string;
        repositories: string[];
        permissions: string[];
      }[];
      subject: { type: "app" };
    },
  ) => Promise<string>;
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
    revision: templateRevision(options, head),
  });
  return { head, rebuilt };
}

function templateRevision(options: RepoSnapshotOptions, head: string): string {
  const scope = createHash("sha256")
    .update(JSON.stringify([options.repository, options.branch ?? "main", options.directory]))
    .digest("hex")
    .slice(0, 12);
  return `${head}-${scope}`;
}

async function mintReadToken(
  options: RepoSnapshotOptions,
  getTokenFn: RepoSnapshotDependencies["getToken"],
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
  const branch = options.branch ?? "main";
  const lockfiles = options.lockfiles ?? DEFAULT_LOCKFILES;
  const checksLockfiles = options.install !== undefined && lockfiles.length > 0;
  const result = await sandbox.run({
    command: [
      "set -e",
      "previous=$(git rev-parse HEAD)",
      `git fetch --no-tags ${shellQuote(`https://github.com/${options.repository}.git`)} ${shellQuote(`+${head}:refs/remotes/origin/${branch}`)}`,
      `git reset --hard --quiet ${shellQuote(head)}`,
      `test "$(git rev-parse HEAD)" = ${shellQuote(head)}`,
      ...(checksLockfiles
        ? [
            "status=0",
            `git diff --quiet "$previous" ${shellQuote(head)} -- ${lockfiles.map(shellQuote).join(" ")} || status=$?`,
            'if [ "$status" -eq 1 ]; then echo lockfile-changed; elif [ "$status" -ne 0 ]; then exit "$status"; fi',
          ]
        : []),
    ].join("\n"),
    env: { GIT_TERMINAL_PROMPT: "0" },
    workingDirectory: options.directory,
  });
  await sandbox.setNetworkPolicy("allow-all");
  if (result.exitCode !== 0) {
    throw new Error(
      `Fetching ${options.repository}@${head} in the sandbox failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  if (result.stdout.split("\n").some((line) => line.trim() === "lockfile-changed")) {
    await options.install?.(sandbox);
  }
}

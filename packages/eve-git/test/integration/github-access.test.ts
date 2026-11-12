import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

import type { GitHubAccess } from "../../extension/lib/github-policy.ts";
import {
  executeGitHubShell,
  type GitHubLeaseRule,
  type GitHubShellInput,
} from "../../extension/lib/github-shell.ts";
import { LEASE_LOCK_PATH } from "../../extension/lib/sandbox-lease-lock.ts";

type NetworkPolicySandboxSession = SandboxSession & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};

interface Repo {
  readonly full_name: string;
  readonly visibility: "public" | "private" | "internal";
  readonly permissions?: { readonly push: boolean };
}

interface Mint {
  readonly org: string;
  readonly repositories?: string[];
  readonly permissions?: string[];
}

/**
 * A fake api.github.com at the fetch edge. `repos` answers `GET /repos/{repo}`;
 * `installs` maps each caller token to the repositories its installations
 * reach. Every request records the token it carried.
 */
function fakeGitHub(options: {
  repos?: Record<string, Repo>;
  installs?: Record<string, Repo[][]>;
  status?: number;
}) {
  const requests: { url: string; token: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /u, "");
    requests.push({ url: `${url.pathname}${url.search}`, token });
    if (options.status) return new Response("{}", { status: options.status });
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const slice = <T>(items: T[]) => items.slice((page - 1) * perPage, page * perPage);
    const repo = /^\/repos\/([^/]+\/[^/]+)$/u.exec(url.pathname);
    if (repo) {
      const found = options.repos?.[repo[1]!];
      return found ? Response.json(found) : new Response("{}", { status: 404 });
    }
    const installs = options.installs?.[token];
    if (!installs) return new Response("{}", { status: 401 });
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: slice(installs.map((_, id) => ({ id }))) });
    }
    const listed = /^\/user\/installations\/(\d+)\/repositories$/u.exec(url.pathname);
    if (listed) return Response.json({ repositories: slice(installs[Number(listed[1])] ?? []) });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function fakeSandbox(runs: string[], leases: number[]): SandboxSession {
  const sandbox: Pick<SandboxSession, "resolvePath" | "run" | "removePath"> &
    Pick<NetworkPolicySandboxSession, "setNetworkPolicy"> = {
    resolvePath: (path: string) => (path.startsWith("/") ? path : `/workspace/${path}`),
    async run(input) {
      // The sandbox lease lock is covered by its own test.
      if (input.command.includes(LEASE_LOCK_PATH)) return { exitCode: 0, stdout: "", stderr: "" };
      runs.push(input.command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async removePath() {},
    async setNetworkPolicy() {
      leases.push(1);
    },
  };
  return sandbox as NetworkPolicySandboxSession;
}

async function broker(
  sandbox: SandboxSession,
  rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
) {
  const allow = Object.fromEntries(
    Object.entries(rules ?? {}).map(([host, entries]) => [host, [...entries]]),
  );
  await (sandbox as NetworkPolicySandboxSession).setNetworkPolicy(
    rules ? { allow: { "*": [], ...allow } } : "allow-all",
  );
}

const PUBLIC: Repo = { full_name: "acme/site", visibility: "public" };
const PRIVATE: Repo = { full_name: "acme/vault", visibility: "private" };
const INTERNAL: Repo = { full_name: "acme/wiki", visibility: "internal" };
const REPOS = { "acme/site": PUBLIC, "acme/vault": PRIVATE, "acme/wiki": INTERNAL };

const READ_COMMAND = "gh pr view 7 --repo acme/site";
const WRITE_COMMAND = "git push origin HEAD:refs/heads/topic";

function input(repository?: string, command = WRITE_COMMAND): GitHubShellInput {
  return {
    command,
    description: "Run a command",
    ...(repository ? { repository } : {}),
  };
}

async function runApp(
  access: GitHubAccess | undefined,
  repository: string,
  options: { command?: string; permissions?: string[]; repos?: Record<string, Repo> } = {},
) {
  const mints: Mint[] = [];
  const authorized: string[] = [];
  const runs: string[] = [];
  const github = fakeGitHub({ repos: options.repos ?? REPOS });
  const result = executeGitHubShell(
    input(repository, options.command),
    {
      connector: "github/robot",
      principalType: "app",
      ...(access ? { access } : {}),
      ...(options.permissions ? { permissions: options.permissions } : {}),
      broker,
      authorize: ({ token }) => {
        authorized.push(token);
        return true;
      },
    },
    {
      sessionId: `app-${access}-${repository}-${Math.random()}`,
      fetch: github.fetch,
      async getConnectToken(_connector, { authorizationDetails: [detail] }) {
        mints.push(detail!);
        return `token-${mints.length}`;
      },
      getSandbox: async () => fakeSandbox(runs, []),
    },
  );
  return { result, mints, authorized, runs, requests: github.requests };
}

const LOOKUP = { type: "github_app_installation", org: "acme", permissions: ["metadata:read"] };

test("public-write mints the configured token for a public repository, read and write commands alike", async () => {
  for (const command of [READ_COMMAND, WRITE_COMMAND]) {
    const app = await runApp("public-write", "acme/site", {
      command,
      permissions: ["contents:write"],
    });
    await app.result;
    assert.deepEqual(app.mints, [
      { ...LOOKUP, repositories: ["site"] },
      {
        type: "github_app_installation",
        org: "acme",
        repositories: ["site"],
        permissions: ["contents:write"],
      },
    ]);
    // The visibility read carries the metadata-only token; authorize sees the command token.
    assert.deepEqual(app.requests, [{ url: "/repos/acme/site", token: "token-1" }]);
    assert.deepEqual(app.authorized, ["token-2"]);
    assert.equal(app.runs.length, 1);
  }
});

test("public-write refuses private and internal repositories after only the metadata mint, reads included", async () => {
  for (const [repository, visibility] of [
    ["acme/vault", "private"],
    ["acme/wiki", "internal"],
  ]) {
    for (const command of [READ_COMMAND, WRITE_COMMAND]) {
      const app = await runApp("public-write", repository!, { command });
      await assert.rejects(
        app.result,
        new RegExp(`access "public-write" refused ${repository}: it is ${visibility}`, "u"),
      );
      assert.deepEqual(
        app.mints.map((mint) => mint.permissions),
        [["metadata:read"]],
      );
      assert.deepEqual(app.authorized, []);
      assert.deepEqual(app.runs, []);
    }
  }
});

test("private-write keeps the configured permissions on private and internal repositories", async () => {
  for (const repository of ["acme/vault", "acme/wiki"]) {
    for (const command of [READ_COMMAND, WRITE_COMMAND]) {
      const app = await runApp("private-write", repository, {
        command,
        permissions: ["contents:write", "pull_requests:write"],
      });
      await app.result;
      assert.deepEqual(
        app.mints.at(-1)?.permissions,
        ["contents:write", "pull_requests:write"],
        repository,
      );
      assert.equal(app.runs.length, 1);
    }
  }
  const unconfigured = await runApp("private-write", "acme/vault");
  await unconfigured.result;
  assert.equal(unconfigured.mints.at(-1)?.permissions, undefined);
});

test("private-write lowers every write to read on a public repository", async () => {
  for (const command of [READ_COMMAND, WRITE_COMMAND]) {
    const configured = await runApp("private-write", "acme/site", {
      command,
      permissions: ["contents:write", "pull_requests:admin", "issues:read", "contents:read"],
    });
    await configured.result;
    assert.deepEqual(configured.mints.at(-1)?.permissions, [
      "contents:read",
      "pull_requests:read",
      "issues:read",
    ]);
    assert.equal(configured.runs.length, 1);

    const unconfigured = await runApp("private-write", "acme/site", { command });
    await unconfigured.result;
    assert.deepEqual(unconfigured.mints.at(-1)?.permissions, ["contents:read", "metadata:read"]);
  }
});

test("a command with no repository or only an owner is refused under each access value", async () => {
  for (const access of ["private-write", "public-write"] as const) {
    for (const repository of [undefined, "acme"]) {
      for (const principalType of ["app", "user"] as const) {
        const mints: Mint[] = [];
        const github = fakeGitHub({});
        let tokens = 0;
        await assert.rejects(
          executeGitHubShell(
            input(repository, "gh repo list acme"),
            { connector: "github/robot", principalType, access, broker, authorize: () => true },
            {
              sessionId: `owner-${access}-${repository}-${principalType}`,
              fetch: github.fetch,
              getToken: async () => {
                tokens++;
                return { token: "user-token" };
              },
              requireAuth: () => assert.fail("must not request re-authorization"),
              async getConnectToken(_connector, { authorizationDetails: [detail] }) {
                mints.push(detail!);
                return "token";
              },
              getSandbox: async () => fakeSandbox([], []),
            },
          ),
          /set repository to owner\/name/u,
          `${access} ${repository} ${principalType}`,
        );
        assert.deepEqual(mints, []);
        assert.equal(tokens, 0);
        assert.deepEqual(github.requests, []);
      }
    }
  }
});

test("without access, App tokens mint as before with no GitHub lookup", async () => {
  const mints: Mint[] = [];
  const github = fakeGitHub({});
  await executeGitHubShell(
    input("acme/site"),
    {
      connector: "github/robot",
      principalType: "app",
      permissions: ["contents:write"],
      broker,
      authorize: () => true,
    },
    {
      sessionId: "app-no-access",
      fetch: github.fetch,
      async getConnectToken(_connector, { authorizationDetails: [detail] }) {
        mints.push(detail!);
        return "token";
      },
      getSandbox: async () => fakeSandbox([], []),
    },
  );
  assert.deepEqual(mints, [
    {
      type: "github_app_installation",
      org: "acme",
      repositories: ["site"],
      permissions: ["contents:write"],
    },
  ]);
  assert.deepEqual(github.requests, []);
});

test("the App visibility lookup fails closed when GitHub does not answer", async () => {
  const app = await runApp("private-write", "acme/missing");
  await assert.rejects(app.result, /GitHub answered 404 to \/repos\/acme\/missing/u);
  assert.deepEqual(app.runs, []);
  assert.deepEqual(app.authorized, []);
});

test("a repository that changes visibility between two commands is judged anew", async () => {
  const repos: Record<string, Repo> = { "acme/site": PUBLIC };
  const first = await runApp("private-write", "acme/site", { repos });
  await first.result;
  assert.deepEqual(first.mints.at(-1)?.permissions, ["contents:read", "metadata:read"]);

  repos["acme/site"] = { ...PUBLIC, visibility: "private" };
  const second = await runApp("private-write", "acme/site", { repos });
  await second.result;
  assert.equal(second.mints.at(-1)?.permissions, undefined);

  repos["acme/site"] = PUBLIC;
  const third = await runApp("public-write", "acme/site", { repos });
  await third.result;
  repos["acme/site"] = { ...PUBLIC, visibility: "private" };
  const fourth = await runApp("public-write", "acme/site", { repos });
  await assert.rejects(fourth.result, /refused acme\/site: it is private/u);
});

test("concurrent App commands each read their own repository with their own token", async () => {
  const [allowed, refused] = [
    await runApp("public-write", "acme/site"),
    await runApp("public-write", "acme/vault"),
  ];
  const results = await Promise.allSettled([allowed.result, refused.result]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.deepEqual(allowed.requests, [{ url: "/repos/acme/site", token: "token-1" }]);
  assert.deepEqual(refused.requests, [{ url: "/repos/acme/vault", token: "token-1" }]);
  assert.deepEqual(allowed.authorized, ["token-2"]);
  assert.deepEqual(refused.authorized, []);
});

function runUser(
  access: GitHubAccess | undefined,
  token: string,
  github: ReturnType<typeof fakeGitHub>,
  runs: string[] = [],
  leases: number[] = [],
  authorized: string[] = [],
  requireAuth: () => never = () => assert.fail("must not request re-authorization"),
) {
  return executeGitHubShell(
    input("acme/vault"),
    {
      connector: "github/v",
      principalType: "user",
      ...(access ? { access } : {}),
      broker,
      authorize: ({ token: minted }) => {
        authorized.push(minted);
        return true;
      },
    },
    {
      sessionId: `user-${token}-${Math.random()}`,
      fetch: github.fetch,
      getToken: async () => ({ token }),
      requireAuth,
      getSandbox: async () => fakeSandbox(runs, leases),
    },
  );
}

test("private-write user commands run while the installation reaches no public repository the caller can push to", async () => {
  const github = fakeGitHub({
    installs: {
      "user-a": [
        [
          { ...PRIVATE, permissions: { push: true } },
          { ...INTERNAL, permissions: { push: true } },
        ],
        [{ ...PUBLIC, permissions: { push: false } }],
      ],
    },
  });
  const runs: string[] = [];
  await runUser("private-write", "user-a", github, runs);
  assert.equal(runs.length, 1);
  assert.deepEqual(
    github.requests.map((request) => request.url),
    [
      "/user/installations?per_page=100&page=1",
      "/user/installations/0/repositories?per_page=100&page=1",
      "/user/installations/1/repositories?per_page=100&page=1",
    ],
  );
  assert.ok(github.requests.every((request) => request.token === "user-a"));
});

test("private-write user commands are refused, naming the repository, when the installation can push to a public one", async () => {
  const github = fakeGitHub({
    installs: {
      "user-b": [
        [
          { ...PRIVATE, permissions: { push: true } },
          { ...PUBLIC, permissions: { push: true } },
        ],
      ],
    },
  });
  const runs: string[] = [];
  const leases: number[] = [];
  const authorized: string[] = [];
  await assert.rejects(
    runUser("private-write", "user-b", github, runs, leases, authorized),
    /access "private-write" refused: the GitHub App installation includes public repositories the caller can write to \(acme\/site\)\. Narrow the App installation/u,
  );
  assert.deepEqual([runs, leases, authorized], [[], [], []]);
});

test("public-write user commands run on public-only installations and are refused when one reaches a private or internal repository", async () => {
  const runs: string[] = [];
  await runUser(
    "public-write",
    "user-a",
    fakeGitHub({ installs: { "user-a": [[{ ...PUBLIC, permissions: { push: true } }]] } }),
    runs,
  );
  assert.equal(runs.length, 1);

  const refused: string[] = [];
  await assert.rejects(
    runUser(
      "public-write",
      "user-b",
      fakeGitHub({ installs: { "user-b": [[PUBLIC, PRIVATE, INTERNAL]] } }),
      refused,
    ),
    /access "public-write" refused: the GitHub App installation includes private or internal repositories \(acme\/vault, acme\/wiki\)/u,
  );
  assert.deepEqual(refused, []);
});

test("the installation check reads every page", async () => {
  const filler = Array.from({ length: 100 }, (_, index) => ({
    full_name: `acme/private-${index}`,
    visibility: "private" as const,
    permissions: { push: true },
  }));
  const github = fakeGitHub({
    installs: { "user-b": [[...filler, { ...PUBLIC, permissions: { push: true } }]] },
  });
  await assert.rejects(runUser("private-write", "user-b", github), /can write to \(acme\/site\)/u);
  assert.ok(
    github.requests.some((request) => request.url.endsWith("repositories?per_page=100&page=2")),
  );
});

test("the user installation check fails closed when GitHub does not answer", async () => {
  const runs: string[] = [];
  await assert.rejects(
    runUser("private-write", "user-a", fakeGitHub({ status: 502 }), runs),
    /GitHub answered 502 to \/user\/installations, so the access policy could not check visibility/u,
  );
  assert.deepEqual(runs, []);
});

test("a rejected user token during the installation check asks the caller to sign in again", async () => {
  const requests: string[] = [];
  await assert.rejects(
    runUser("private-write", "stale", fakeGitHub({ installs: {} }), [], [], [], () => {
      requests.push("requireAuth");
      throw new Error("authorization required");
    }),
    /authorization required/u,
  );
  assert.deepEqual(requests, ["requireAuth"]);
});

test("user commands without access make no installation reads", async () => {
  const github = fakeGitHub({});
  const runs: string[] = [];
  await runUser(undefined, "user-a", github, runs);
  assert.deepEqual(github.requests, []);
  assert.equal(runs.length, 1);
});

test("each caller's own installation decides only that caller's command, in either order", async () => {
  const github = fakeGitHub({
    installs: {
      "user-a": [[{ ...PRIVATE, permissions: { push: true } }]],
      "user-b": [[{ ...PUBLIC, permissions: { push: true } }]],
    },
  });
  for (const order of [
    ["user-a", "user-b"],
    ["user-b", "user-a"],
  ]) {
    const runs: Record<string, string[]> = { "user-a": [], "user-b": [] };
    const authorized: Record<string, string[]> = { "user-a": [], "user-b": [] };
    const results = await Promise.allSettled(
      order.map((token) =>
        runUser("private-write", token, github, runs[token], [], authorized[token]),
      ),
    );
    const byToken = Object.fromEntries(order.map((token, index) => [token, results[index]!]));
    assert.equal(byToken["user-a"]!.status, "fulfilled", order.join(","));
    assert.equal(byToken["user-b"]!.status, "rejected", order.join(","));
    assert.match(String((byToken["user-b"] as PromiseRejectedResult).reason), /acme\/site/u);
    assert.deepEqual(authorized, { "user-a": ["user-a"], "user-b": [] });
    assert.equal(runs["user-a"]!.length, 1);
    assert.deepEqual(runs["user-b"], []);
  }
  assert.ok(
    github.requests.every(
      (request) =>
        request.url.startsWith("/user/installations") &&
        ["user-a", "user-b"].includes(request.token),
    ),
  );
});

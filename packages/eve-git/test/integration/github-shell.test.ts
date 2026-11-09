import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ConnectTokenParams } from "@vercel/connect";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";

type NetworkPolicySandboxSession = SandboxSession & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};

import {
  executeGitHubShell,
  githubShellApproval,
  parseCommand,
  type GitHubAppAuthorizeRequest,
  type GitHubLeaseRule,
  type GitHubShellInput,
} from "../../extension/lib/github-shell.ts";
import { LEASE_LOCK_PATH, withSandboxLeaseLock } from "../../extension/lib/sandbox-lease-lock.ts";

type NetworkPolicy = Parameters<NetworkPolicySandboxSession["setNetworkPolicy"]>[0];

const CONFIG = {
  connector: "github/citron-compass",
  principalType: "app" as const,
  authorize: () => true,
  async broker(
    sandbox: SandboxSession,
    rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
  ) {
    const allow = Object.fromEntries(
      Object.entries(rules ?? {}).map(([host, entries]) => [host, [...entries]]),
    );
    await (sandbox as NetworkPolicySandboxSession).setNetworkPolicy(
      rules ? { allow: { "*": [], ...allow } } : "allow-all",
    );
  },
};

const READ: GitHubShellInput = {
  command: "gh pr view 2583 --repo vercel/internal-agents",
  description: "Read PR 2583",
  repository: "vercel/internal-agents",
};

const WRITE: GitHubShellInput = {
  command: "git push origin HEAD:refs/heads/rui/my-branch",
  description: "Update the existing PR branch",
  repository: "vercel/internal-agents",
  workingDirectory: "/workspace/internal-agents",
};

const CLONE: GitHubShellInput = {
  command: "gh repo clone vercel/internal-agents /workspace/internal-agents",
  description: "Clone the repository into the sandbox",
  repository: "vercel/internal-agents",
};

test("parses simple argv quoting without enabling a shell language", () => {
  assert.deepEqual(parseCommand(`gh pr comment 1 --body "it's ready"`), [
    "gh",
    "pr",
    "comment",
    "1",
    "--body",
    "it's ready",
  ]);
  for (const command of [
    "gh pr view 1 | cat",
    "gh pr view $(printenv)",
    "gh pr view 1 > out",
    "gh pr view 1; env",
  ]) {
    assert.throws(() => parseCommand(command), /GitHub commands|argv syntax/u, command);
  }
});

test("runs every valid authenticated GitHub command without approval", () => {
  assert.equal(githubShellApproval(CLONE), "not-applicable");
  assert.equal(githubShellApproval(READ), "not-applicable");
  assert.equal(githubShellApproval(WRITE), "not-applicable");
});

test("runs clone without approval while retaining repository-scoped write-capable tokens", async () => {
  const tokenCalls: Array<{ connector: string; params: ConnectTokenParams }> = [];
  const runs: Parameters<SandboxSession["run"]>[0][] = [];

  await executeGitHubShell(CLONE, CONFIG, {
    sessionId: "session-1",
    async getConnectToken(connector, params) {
      tokenCalls.push({ connector, params });
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox(runs, { exitCode: 0, stdout: "", stderr: "" });
    },
  });

  assert.equal(githubShellApproval(CLONE), "not-applicable");
  assert.deepEqual(tokenCalls, [
    {
      connector: "github/citron-compass",
      params: {
        authorizationDetails: [
          {
            type: "github_app_installation",
            org: "vercel",
            repositories: ["internal-agents"],
          },
        ],
        subject: { type: "app" },
      },
    },
  ]);
  assert.equal(runs.length, 1);
});

test("asks authorize with the argv, caller, owner, repository, and token before running", async () => {
  const auth = {
    attributes: {},
    authenticator: "github-webhook",
    principalId: "github:octocat",
    principalType: "user",
    subject: "octocat",
  };
  const requests: unknown[] = [];
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  const dependencies = {
    auth,
    sessionId: "session-authorize",
    async getConnectToken() {
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox(runs, { exitCode: 0, stdout: "", stderr: "" });
    },
  };

  await assert.rejects(
    executeGitHubShell(
      READ,
      {
        ...CONFIG,
        authorize: (request: GitHubAppAuthorizeRequest) => {
          requests.push(request);
          return false;
        },
      },
      dependencies,
    ),
    /not authorized to run this command on vercel\/internal-agents/u,
  );
  assert.deepEqual(requests, [
    {
      argv: ["gh", "pr", "view", "2583", "--repo", "vercel/internal-agents"],
      auth,
      owner: "vercel",
      repository: "vercel/internal-agents",
      token: "secret-token",
    },
  ]);
  assert.equal(runs.length, 0);

  await executeGitHubShell(READ, { ...CONFIG, authorize: async () => true }, dependencies);
  assert.equal(runs.length, 1);
});

test("resolves one user grant for every repository through ctx.getToken and re-authorizes on 401", async () => {
  const getTokenCalls: Parameters<ToolContext["getToken"]>[] = [];
  const requireAuthCalls: Parameters<ToolContext["requireAuth"]>[] = [];
  const getToken: ToolContext["getToken"] = async (...args) => {
    getTokenCalls.push(args);
    return { token: "user-token" };
  };
  const requireAuth: ToolContext["requireAuth"] = (...args) => {
    requireAuthCalls.push(args);
    throw new Error("authorization required");
  };
  const config = { ...CONFIG, principalType: "user" as const, authorize: () => true };
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  let stderr = "";
  const dependencies = {
    getToken,
    requireAuth,
    sessionId: "session-user-auth",
    async getConnectToken(): Promise<string> {
      throw new Error("user-scoped access must not mint app tokens");
    },
    async getSandbox() {
      return fakeSandbox(runs, () => ({ exitCode: stderr ? 1 : 0, stdout: "", stderr }));
    },
  };

  await executeGitHubShell(READ, config, dependencies);
  await executeGitHubShell(
    {
      ...READ,
      command: "gh pr view 7 --repo acme/widgets",
      repository: "acme/widgets",
    },
    config,
    dependencies,
  );
  // User tokens need no owner, so commands tied to no repository still run.
  await executeGitHubShell(
    { command: "gh api user/repos", description: "List the caller's repositories" },
    config,
    dependencies,
  );

  // No authKey: eve files both repositories' sign-in under the connector, so
  // one grant serves them, and no call carries repository-specific options.
  assert.equal(getTokenCalls.length, 3);
  for (const [provider, options] of getTokenCalls) {
    assert.equal(options, undefined);
    assert.equal(provider.principalType, "user");
    assert.deepEqual(provider.vercelConnect, { connector: "github/citron-compass" });
  }
  assert.equal(requireAuthCalls.length, 0);

  stderr = "HTTP 401: Bad credentials (https://api.github.com/graphql)";
  await assert.rejects(executeGitHubShell(READ, config, dependencies), /authorization required/u);
  assert.equal(requireAuthCalls.length, 1);
  assert.equal(requireAuthCalls[0]![0]!.principalType, "user");
  assert.equal(requireAuthCalls[0]![1], undefined);

  // gh-signed-commit reports a rejected token through its own API errors.
  stderr = "GitHub ref lookup failed: 401";
  await assert.rejects(executeGitHubShell(READ, config, dependencies), /authorization required/u);
  assert.equal(requireAuthCalls.length, 2);
  assert.equal(runs.length, 5);
});

test("user tokens cannot satisfy repository allowlists with a declared target", async () => {
  for (const command of [
    "gh api repos/acme/private",
    'gh api graphql -f \'query={repository(owner:"acme",name:"private"){name}}\'',
    "gh pr view 7 --repo acme/private",
    "git ls-remote https://github.com/acme/private.git",
    READ.command,
  ]) {
    const requests: Array<string | null> = [];
    const runs: Parameters<SandboxSession["run"]>[0][] = [];
    let leases = 0;
    await assert.rejects(
      executeGitHubShell(
        { ...READ, command },
        {
          ...CONFIG,
          principalType: "user",
          authorize: ({ repository }) => {
            requests.push(repository);
            return repository === READ.repository;
          },
          async broker() {
            leases += 1;
          },
        },
        {
          sessionId: "session-user-allowlist",
          getToken: async () => ({ token: "user-token" }),
          requireAuth() {
            assert.fail("must not request re-authorization");
          },
          async getSandbox() {
            return fakeSandbox(runs, { exitCode: 0, stdout: "", stderr: "" });
          },
        },
      ),
      /not authorized to run this command/u,
      command,
    );
    assert.deepEqual(requests, [null]);
    assert.equal(leases, 0);
    assert.equal(runs.length, 0);
  }
});

test("approves the full syntactically valid gh surface", () => {
  for (const command of [
    "gh api repos/vercel/internal-agents",
    "gh auth token",
    "gh auth status",
    "gh alias set pwn '!env'",
    "gh extension exec x",
    "gh repo view vercel/internal-agents --web",
    "gh pr view 2583 --repo vercel/internal-agents --browser",
  ]) {
    assert.equal(githubShellApproval({ ...READ, command }), "not-applicable", command);
  }
});

test("fails closed on missing commands, other executables, env assignments, and shell syntax", () => {
  for (const command of [
    "gh",
    "git",
    "GH_TOKEN=stolen gh auth status",
    "env GH_TOKEN=stolen gh auth status",
    "bash -lc gh",
    "curl https://api.github.com/user",
  ]) {
    const decision = githubShellApproval({ ...WRITE, command });
    assert.equal(typeof decision, "object", command);
    assert.ok((decision as { reason: string }).reason.length > 0);
  }
  for (const command of ["gh auth status | env", "gh auth status; env", "gh auth status > token"]) {
    assert.throws(() => parseCommand(command), /argv syntax/u, command);
  }
});

test("allows any gh or git subcommand and leaves the decision to authorize", () => {
  for (const command of [
    "git clone https://github.com/vercel/eve.git",
    "git remote -v",
    "git push upstream HEAD",
    "gh repo list vercel",
    "gh search repos agent --owner vercel",
  ]) {
    assert.equal(githubShellApproval({ ...READ, command }), "not-applicable", command);
  }
});

test("rejects invalid repositories before sandbox access or token minting", async () => {
  for (const repository of ["not/a/repository", "-bad", "vercel/"]) {
    const input = { ...READ, repository };
    const decision = githubShellApproval(input);
    assert.equal(typeof decision, "object", repository);
    await assert.rejects(
      executeGitHubShell(input, CONFIG, {
        sessionId: "session-1",
        async getSandbox() {
          assert.fail("invalid repositories must not access the sandbox");
        },
        async getConnectToken() {
          assert.fail("invalid repositories must not mint a token");
        },
      }),
      /Invalid GitHub repository or owner/u,
      repository,
    );
  }
});

test("requires an owner for app tokens before sandbox access", async () => {
  await assert.rejects(
    executeGitHubShell({ command: "gh api user/repos", description: "List repos" }, CONFIG, {
      sessionId: "session-1",
      async getSandbox() {
        assert.fail("must not access the sandbox");
      },
      async getConnectToken() {
        assert.fail("must not mint a token");
      },
    }),
    /App tokens need repository set to an owner or owner\/name/u,
  );
});

test("mints a repository-scoped token only during execution and redacts output", async () => {
  const tokenCalls: Array<{ connector: string; params: ConnectTokenParams }> = [];
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  const policies: NetworkPolicy[] = [];
  const output = await executeGitHubShell(WRITE, CONFIG, {
    sessionId: "session-1",
    async getConnectToken(connector, params) {
      tokenCalls.push({ connector, params });
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox(
        runs,
        (run) => {
          const stdout = run.command.includes("realpath -e -z -- '/workspace/internal-agents'")
            ? "/workspace/internal-agents\0"
            : run.command.includes("realpath -e")
              ? "/workspace\0"
              : run.command.includes("rev-parse --show-toplevel")
                ? "/workspace/internal-agents\n"
                : run.command.includes("remote get-url")
                  ? "https://github.com/vercel/internal-agents.git\n"
                  : "pushed secret-token";
          return { exitCode: 0, stdout, stderr: "" };
        },
        policies,
      );
    },
  });

  assert.deepEqual(tokenCalls, [
    {
      connector: "github/citron-compass",
      params: {
        authorizationDetails: [
          {
            type: "github_app_installation",
            org: "vercel",
            repositories: ["internal-agents"],
          },
        ],
        subject: { type: "app" },
      },
    },
  ]);
  assert.equal(runs.length, 1);
  const push = runs[0]!;
  assert.equal(
    push.command,
    "cd '/workspace/internal-agents' && exec 'git' 'push' 'origin' 'HEAD:refs/heads/rui/my-branch'",
  );
  assert.equal(push.env?.GH_TOKEN, undefined);
  assert.equal(push.env?.GIT_CONFIG_COUNT, "6");
  assert.equal(push.env?.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.match(push.env?.GIT_CONFIG_VALUE_0 ?? "", /^Authorization: Basic /u);
  assert.doesNotMatch(JSON.stringify(push.env), /secret-token/u);
  assert.equal(push.env?.GIT_CONFIG_VALUE_3, "/dev/null");
  assert.deepEqual(
    [push.env?.GIT_CONFIG_KEY_4, push.env?.GIT_CONFIG_VALUE_4],
    ["protocol.allow", "never"],
  );
  assert.deepEqual(
    [push.env?.GIT_CONFIG_KEY_5, push.env?.GIT_CONFIG_VALUE_5],
    ["protocol.https.allow", "always"],
  );
  assert.match(JSON.stringify(policies[0]), /secret-token/u);
  assert.equal(policies[1], "allow-all");
  assert.equal(output.stdout, "pushed [redacted]");
});

test("leases the token to uploads.github.com the same way as api.github.com", async () => {
  const policies: NetworkPolicy[] = [];
  await executeGitHubShell(READ, CONFIG, {
    sessionId: "session-1",
    async getConnectToken() {
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" }, policies);
    },
  });
  const lease = policies[0] as { allow: Record<string, unknown> };
  assert.match(JSON.stringify(lease.allow["api.github.com"]), /Bearer secret-token/u);
  assert.deepEqual(lease.allow["uploads.github.com"], lease.allow["api.github.com"]);
});

test("rewrites SSH GitHub remotes to HTTPS so they carry the credential", async () => {
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  await executeGitHubShell(WRITE, CONFIG, {
    sessionId: "session-1",
    async getConnectToken() {
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox(runs, () => ({ exitCode: 0, stdout: "", stderr: "" }), []);
    },
  });
  const repository = mkdtempSync(join(tmpdir(), "eve-git-ssh-"));
  // Only the git config: the sandbox PATH would hide the host's git.
  const gitConfig = Object.fromEntries(
    Object.entries(runs[0]!.env ?? {}).filter(([key]) => key.startsWith("GIT_CONFIG_")),
  );
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, ...gitConfig },
      }).trim();
    git("init", "-q");
    for (const remote of [
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
    ]) {
      git("remote", "add", "origin", remote);
      assert.equal(git("remote", "get-url", "origin"), "https://github.com/acme/widgets.git");
      assert.equal(
        git("remote", "get-url", "--push", "origin"),
        "https://github.com/acme/widgets.git",
      );
      git("remote", "remove", "origin");
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("runs gh auth token with only the placeholder credential and redacts injected secrets", async () => {
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  const policies: NetworkPolicy[] = [];
  const output = await executeGitHubShell({ ...READ, command: "gh auth token" }, CONFIG, {
    sessionId: "session-1",
    async getConnectToken() {
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox(
        runs,
        (run) => ({
          exitCode: 0,
          stdout: `${run.env?.GH_TOKEN ?? "missing"}\ninjected secret-token`,
          stderr: `injected secret-token`,
        }),
        policies,
      );
    },
  });

  assert.equal(runs.length, 1);
  assert.match(runs[0]?.command ?? "", /eve-code\/gh' 'auth' 'token'$/u);
  const placeholder = runs[0]?.env?.GH_TOKEN;
  assert.match(placeholder ?? "", /^eve-github-/u);
  assert.doesNotMatch(JSON.stringify(runs[0]?.env), /secret-token/u);
  assert.equal(output.stdout, `${placeholder}\ninjected [redacted]`);
  assert.equal(output.stderr, "injected [redacted]");
  assert.match(JSON.stringify(policies[0]), /secret-token/u);
  assert.equal(policies[1], "allow-all");
});

test("accepts workspace-relative working directories and rejects escapes", async () => {
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  const sandbox = fakeSandbox(runs, { exitCode: 0, stdout: "ok", stderr: "" });
  const output = await executeGitHubShell(
    { ...READ, workingDirectory: "internal-agents" },
    CONFIG,
    {
      sessionId: "session-1",
      async getConnectToken() {
        return "token";
      },
      async getSandbox() {
        return sandbox;
      },
    },
  );
  assert.equal(output.exitCode, 0);
  assert.match(runs[0]?.command ?? "", /^cd '\/workspace\/internal-agents' /u);

  await assert.rejects(
    executeGitHubShell({ ...READ, workingDirectory: "../outside" }, CONFIG, {
      sessionId: "session-1",
      async getConnectToken() {
        return "token";
      },
      async getSandbox() {
        return sandbox;
      },
    }),
    /must stay inside the sandbox workspace/u,
  );
});

test("rejects owner-only repositories for user tokens before sandbox access", async () => {
  await assert.rejects(
    executeGitHubShell(
      { command: "gh repo list vercel", description: "List repos", repository: "vercel" },
      { ...CONFIG, principalType: "user", authorize: () => true },
      {
        sessionId: "session-1",
        async getSandbox() {
          assert.fail("must not access the sandbox");
        },
      },
    ),
    /Set repository to owner\/name or omit it/u,
  );
});

test("leaves explicit command targets to authorize through argv", async () => {
  const requests: { argv: readonly string[]; repository: string | null }[] = [];
  await assert.rejects(
    executeGitHubShell(
      { ...READ, command: "gh pr view 2583 --repo vercel/eve" },
      {
        ...CONFIG,
        authorize: ({ argv, repository }: GitHubAppAuthorizeRequest) => {
          requests.push({ argv, repository });
          return !argv.includes("--repo") || argv[argv.indexOf("--repo") + 1] === repository;
        },
      },
      {
        sessionId: "session-1",
        async getConnectToken() {
          return "token";
        },
        async getSandbox() {
          return fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" });
        },
      },
    ),
    /not authorized/u,
  );
  assert.deepEqual(requests, [
    {
      argv: ["gh", "pr", "view", "2583", "--repo", "vercel/eve"],
      repository: "vercel/internal-agents",
    },
  ]);
});

test("mints an owner-wide installation token for owner-level discovery", async () => {
  const tokenCalls: ConnectTokenParams[] = [];
  const requests: { owner: string; repository: string | null }[] = [];
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  await executeGitHubShell(
    {
      command: "gh repo list vercel",
      description: "List vercel repositories",
      repository: "vercel",
    },
    {
      ...CONFIG,
      authorize: ({ owner, repository }: GitHubAppAuthorizeRequest) => {
        requests.push({ owner, repository });
        return owner === "vercel";
      },
    },
    {
      sessionId: "session-1",
      async getConnectToken(_connector, params) {
        tokenCalls.push(params);
        return "token";
      },
      async getSandbox() {
        return fakeSandbox(runs, { exitCode: 0, stdout: "", stderr: "" });
      },
    },
  );
  assert.deepEqual(tokenCalls, [
    {
      authorizationDetails: [{ type: "github_app_installation", org: "vercel" }],
      subject: { type: "app" },
    },
  ]);
  assert.deepEqual(requests, [{ owner: "vercel", repository: null }]);
  assert.equal(runs.length, 1);
});

test("scopes app tokens to the declared owner's installation and leaves owners to authorize", async () => {
  const tokenCalls: ConnectTokenParams[] = [];
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  const repositories: string[] = [];
  await assert.rejects(
    executeGitHubShell(
      {
        ...READ,
        command: "gh pr view 7 --repo acme/widgets",
        repository: "acme/widgets",
      },
      {
        ...CONFIG,
        authorize: ({ repository }: GitHubAppAuthorizeRequest) => {
          repositories.push(repository!);
          return repository!.toLowerCase().startsWith("vercel/");
        },
      },
      {
        sessionId: "session-1",
        async getConnectToken(_connector, params) {
          tokenCalls.push(params);
          return "token";
        },
        async getSandbox() {
          return fakeSandbox(runs, { exitCode: 0, stdout: "", stderr: "" });
        },
      },
    ),
    /not authorized to run this command on acme\/widgets/u,
  );
  assert.deepEqual(tokenCalls, [
    {
      authorizationDetails: [
        { type: "github_app_installation", org: "acme", repositories: ["widgets"] },
      ],
      subject: { type: "app" },
    },
  ]);
  assert.deepEqual(repositories, ["acme/widgets"]);
  assert.equal(runs.length, 0);
});

test("attributes pull requests to the person the tool context resolves", async () => {
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  const contexts: unknown[] = [];
  const context = { session: { id: "session-1" } } as ToolContext;
  const config = {
    ...CONFIG,
    attribution(ctx: ToolContext) {
      contexts.push(ctx);
      return { name: "octocat", email: "1+octocat@users.noreply.github.com" };
    },
  };
  const dependencies = {
    context,
    sessionId: "session-1",
    async getConnectToken() {
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox(runs, { exitCode: 0, stdout: "", stderr: "" });
    },
  };
  await executeGitHubShell(READ, config, dependencies);
  assert.deepEqual(contexts, [], "read commands never resolve attribution");

  await executeGitHubShell(
    { ...READ, command: 'gh pr create --repo vercel/internal-agents --title T --body "Why."' },
    config,
    dependencies,
  );

  assert.deepEqual(contexts, [context]);
  assert.match(
    runs.at(-1)?.command ?? "",
    /'--body' 'Why\.\n\nCo-authored-by: octocat <1\+octocat@users\.noreply\.github\.com>'$/u,
  );
});

test("serializes credential leases across sessions that share one sandbox", async () => {
  // Subagents share their parent's sandbox. Each lease replaces the sandbox's network policy, so
  // overlapping leases would swap or clear each other's credential mid-command.
  const lockRoot = mkdtempSync(join(tmpdir(), "eve-git-lease-"));
  const lockPath = join(lockRoot, "lease.lock");
  const policies: NetworkPolicy[] = [];
  const events: string[] = [];
  let active: NetworkPolicy | undefined;
  let release!: () => void;
  const firstCommandRunning = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sandboxFake: Pick<SandboxSession, "resolvePath" | "run" | "removePath"> &
    Pick<NetworkPolicySandboxSession, "setNetworkPolicy"> = {
    resolvePath: (path: string) => (path === "." ? "/workspace" : path),
    async removePath() {},
    async setNetworkPolicy(policy: NetworkPolicy) {
      policies.push(policy);
      active = policy;
    },
    async run(input: Parameters<SandboxSession["run"]>[0]) {
      if (input.command.includes(LEASE_LOCK_PATH)) return runLockCommand(input.command, lockPath);
      const name = input.command.includes("'1'") ? "first" : "second";
      const placeholder = input.env?.GH_TOKEN ?? "";
      // The command's own credential must be leased for as long as it runs.
      assert.match(JSON.stringify(active), new RegExp(placeholder, "u"));
      events.push(`${name} start`);
      if (name === "first") {
        started();
        await firstCommandRunning;
        assert.match(JSON.stringify(active), new RegExp(placeholder, "u"));
      }
      events.push(`${name} end`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const sandbox = sandboxFake as NetworkPolicySandboxSession;
  const run = (pr: string, sessionId: string) =>
    executeGitHubShell(
      { ...READ, command: `gh pr view ${pr} --repo vercel/internal-agents` },
      CONFIG,
      {
        sessionId,
        getConnectToken: async () => `token-${pr}`,
        getSandbox: async () => sandbox,
      },
    );

  try {
    const first = run("1", "child-1");
    await firstStarted;
    const second = run("2", "child-2");
    // The second lease waits on the first command instead of replacing its credential.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(policies.length, 1);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first start", "first end", "second start", "second end"]);
    assert.deepEqual(
      policies.map((policy) => (policy === "allow-all" ? "cleared" : "leased")),
      ["leased", "cleared", "leased", "cleared"],
    );
    assert.equal(execFileSync("ls", ["-A", lockRoot], { encoding: "utf8" }), "");
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("a lease does not release a lock another command holds", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "eve-git-lease-"));
  const lockPath = join(lockRoot, "lease.lock");
  try {
    // A holder whose lock was broken as stale must not release its successor's lock.
    execFileSync("mkdir", [lockPath]);
    execFileSync("sh", ["-c", `printf successor > '${lockPath}/owner'`]);
    let calls = 0;
    const sandboxFake: Pick<SandboxSession, "run"> = {
      async run(input: Parameters<SandboxSession["run"]>[0]) {
        calls += 1;
        // Skip acquisition: simulate the stale holder releasing after its lock was broken.
        if (calls === 1) return { exitCode: 0, stdout: "", stderr: "" };
        return runLockCommand(input.command, lockPath);
      },
    };
    let cleaned = false;
    await withSandboxLeaseLock(
      sandboxFake as SandboxSession,
      "stale-holder",
      async () => undefined,
      {
        cleanup: async () => {
          cleaned = true;
        },
      },
    );
    // Nor clear its successor's credential.
    assert.equal(cleaned, false);
    assert.equal(execFileSync("cat", [`${lockPath}/owner`], { encoding: "utf8" }), "successor");
    assert.equal(execFileSync("ls", ["-A", lockRoot], { encoding: "utf8" }), "lease.lock\n");
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("a lease breaks a lock whose holder stopped", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "eve-git-lease-"));
  const lockPath = join(lockRoot, "lease.lock");
  try {
    execFileSync("mkdir", [lockPath]);
    execFileSync("sh", ["-c", `printf stopped > '${lockPath}/owner'`]);
    execFileSync("touch", ["-t", "200001010000", lockPath]);
    const sandboxFake: Pick<SandboxSession, "run"> = {
      run: (input) => runLockCommand(input.command, lockPath),
    };
    let owner = "";
    let cleanedWhileHeld = "";
    await withSandboxLeaseLock(
      sandboxFake as SandboxSession,
      "next",
      async () => {
        owner = execFileSync("cat", [`${lockPath}/owner`], { encoding: "utf8" });
      },
      {
        cleanup: async () => {
          cleanedWhileHeld = execFileSync("cat", [`${lockPath}/owner`], { encoding: "utf8" });
        },
      },
    );
    assert.equal(owner, "next");
    // The holder cleans up before it gives up the lock.
    assert.equal(cleanedWhileHeld, "next");
    assert.equal(execFileSync("ls", ["-A", lockRoot], { encoding: "utf8" }), "");
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("a lease waits on the host and stops when its call is cancelled", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "eve-git-lease-"));
  const lockPath = join(lockRoot, "lease.lock");
  try {
    execFileSync("mkdir", [lockPath]);
    execFileSync("sh", ["-c", `printf holder > '${lockPath}/owner'`]);
    let attempts = 0;
    const sandboxFake: Pick<SandboxSession, "run"> = {
      run(input) {
        attempts += 1;
        return runLockCommand(input.command, lockPath);
      },
    };
    const controller = new AbortController();
    let ran = false;
    const waiting = withSandboxLeaseLock(
      sandboxFake as SandboxSession,
      "waiter",
      async () => {
        ran = true;
      },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Each attempt returns at once instead of waiting inside the sandbox.
    assert.ok(attempts > 1);
    controller.abort(new Error("cancelled"));
    await assert.rejects(waiting, /cancelled/u);
    assert.equal(ran, false);
    assert.equal(execFileSync("cat", [`${lockPath}/owner`], { encoding: "utf8" }), "holder");
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

/** Runs a lease lock command in a real shell against `lockPath` instead of the sandbox's path. */
async function runLockCommand(
  command: string,
  lockPath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)("sh", [
      "-c",
      command.replaceAll(LEASE_LOCK_PATH, lockPath),
    ]);
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

function fakeSandbox(
  runs: Parameters<SandboxSession["run"]>[0][],
  result:
    | { exitCode: number; stdout: string; stderr: string }
    | ((input: Parameters<SandboxSession["run"]>[0]) => {
        exitCode: number;
        stdout: string;
        stderr: string;
      }),
  policies: NetworkPolicy[] = [],
): SandboxSession {
  const sandbox: Pick<SandboxSession, "resolvePath" | "run" | "removePath"> &
    Pick<NetworkPolicySandboxSession, "setNetworkPolicy"> = {
    resolvePath(path: string) {
      if (path === ".") return "/workspace";
      if (path.startsWith("/")) return path;
      return `/workspace/${path}`;
    },
    async run(input: Parameters<SandboxSession["run"]>[0]) {
      // The sandbox lease lock is covered by its own test.
      if (input.command.includes(LEASE_LOCK_PATH)) return { exitCode: 0, stdout: "", stderr: "" };
      runs.push(input);
      return typeof result === "function" ? result(input) : result;
    },
    async removePath() {},
    async setNetworkPolicy(policy: NetworkPolicy) {
      policies.push(policy);
    },
  };
  return sandbox as NetworkPolicySandboxSession;
}

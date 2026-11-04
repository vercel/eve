import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import git from "../../extension/extension.ts";
import {
  leasePlaceholder,
  lockSeconds,
  withGitHubLease,
} from "../../extension/lib/github-lease.ts";

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
  async readRules(sandbox: SandboxSession) {
    return readGitHubRules(sandbox);
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
    "cd '/workspace/internal-agents' && exec timeout -k 10 1800 'git' 'push' 'origin' 'HEAD:refs/heads/rui/my-branch'",
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
    async getConnectToken() {
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" }, policies);
    },
  });
  const lease = policies[0] as { allow: Record<string, GitHubLeaseRule[]> };
  assert.match(JSON.stringify(lease.allow["api.github.com"]), /Bearer secret-token/u);
  assert.deepEqual(
    lease.allow["uploads.github.com"]![0]!.transform,
    lease.allow["api.github.com"]![0]!.transform,
  );
  assert.deepEqual(
    lease.allow["uploads.github.com"]![0]!.match!.headers,
    lease.allow["api.github.com"]![0]!.match!.headers,
  );
});

test("rewrites SSH GitHub remotes to HTTPS so they carry the credential", async () => {
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  await executeGitHubShell(WRITE, CONFIG, {
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

test("concurrent commands on one sandbox keep each other's credential rules", async () => {
  // A parent turn and its subagents share one sandbox through separate handles
  // in separate processes; only the sandbox (its policy and its lock) is shared.
  const shared = sharedSandbox();
  const tokens = new Map<string, string>();
  let releaseParent!: () => void;
  const parentHeld = new Promise<void>((resolve) => (releaseParent = resolve));
  const seen: string[] = [];
  const run = (label: string) => async (input: Parameters<SandboxSession["run"]>[0]) => {
    // What the firewall would do with this command's placeholder right now.
    const rules = (shared.policy as { allow: Record<string, GitHubLeaseRule[]> }).allow;
    const placeholder = input.env!.GH_TOKEN!;
    const rule = rules["api.github.com"]?.find((entry) =>
      entry.match?.headers?.[0]?.value?.regex?.includes(placeholder.replaceAll(".", "\\.")),
    );
    seen.push(`${label}:${rule?.transform[0]?.headers.authorization ?? "401"}`);
    if (label === "parent") await parentHeld;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const handle = (label: string) => {
    const sandbox = fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" }, [], shared);
    return Object.assign(sandbox, { run: run(label) });
  };
  const execute = (label: string, repository: string) =>
    executeGitHubShell(
      { command: `gh api repos/${repository}`, description: "Read", repository },
      CONFIG,
      {
        async getConnectToken(_connector, params) {
          const detail = params.authorizationDetails![0] as { repositories?: string[] };
          const token = `token-${detail.repositories![0]}`;
          tokens.set(label, token);
          return token;
        },
        async getSandbox() {
          return handle(label);
        },
      },
    );

  const parent = execute("parent", "vercel/eve");
  while (!seen.some((entry) => entry.startsWith("parent:"))) await new Promise(setImmediate);
  for (let index = 0; index < 5; index += 1) {
    await Promise.all([execute("a", "vercel/a"), execute("b", "vercel/b")]);
  }
  // The parent's rule outlives every subagent command that started and ended meanwhile.
  const rules = (shared.policy as { allow: Record<string, GitHubLeaseRule[]> }).allow;
  assert.equal(rules["api.github.com"]!.length, 1);
  assert.equal(
    rules["api.github.com"]![0]!.transform[0]!.headers.authorization,
    "Bearer token-eve",
  );
  releaseParent();
  await parent;

  assert.deepEqual(
    new Set(seen),
    new Set(["parent:Bearer token-eve", "a:Bearer token-a", "b:Bearer token-b"]),
  );
  assert.equal(shared.policy, "allow-all");
});

test("scopes each rule to the declared repository by request path", async () => {
  const policies: NetworkPolicy[] = [];
  await executeGitHubShell(READ, CONFIG, {
    async getConnectToken() {
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" }, policies);
    },
  });
  const rules = (policies[0] as { allow: Record<string, GitHubLeaseRule[]> }).allow;
  const path = (host: string) =>
    new RegExp(rules[host]![0]!.match!.path!.regex.replace("(?i)", ""), "iu");
  assert.ok(path("api.github.com").test("/repos/vercel/internal-agents/pulls/1"));
  assert.ok(path("api.github.com").test("/repos/vercel/internal-agents"));
  assert.ok(path("api.github.com").test("/graphql"));
  assert.ok(!path("api.github.com").test("/repos/vercel/internal-agents-fork/pulls"));
  assert.ok(!path("api.github.com").test("/user"));
  assert.ok(path("uploads.github.com").test("/repos/vercel/internal-agents/releases/1/assets"));
  assert.ok(!path("uploads.github.com").test("/repos/vercel/other/releases/1/assets"));
  assert.ok(path("github.com").test("/vercel/internal-agents.git/git-receive-pack"));
  assert.ok(path("github.com").test("/Vercel/Internal-Agents/info/refs"));
  assert.ok(!path("github.com").test("/vercel/other.git/info/refs"));

  // A command with no repository gets an unscoped rule for that command only.
  const unscoped: NetworkPolicy[] = [];
  await executeGitHubShell(
    { command: "gh api user", description: "Read the caller" },
    { ...CONFIG, principalType: "user", authorize: () => true },
    {
      getToken: async () => ({ token: "user-token" }),
      requireAuth() {
        assert.fail("must not request re-authorization");
      },
      async getSandbox() {
        return fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" }, unscoped);
      },
    },
  );
  const open = (unscoped[0] as { allow: Record<string, GitHubLeaseRule[]> }).allow;
  for (const host of ["api.github.com", "uploads.github.com", "github.com"]) {
    assert.equal(open[host]![0]!.match!.path, undefined, host);
  }
});

test("drops rules it cannot vouch for: expired leases and other callers' user leases", async () => {
  const shared = sharedSandbox();
  const policies: NetworkPolicy[] = [];
  const userConfig = { ...CONFIG, principalType: "user" as const, authorize: () => true };
  const user = (principalId: string, inspect?: () => void) =>
    executeGitHubShell(READ, userConfig, {
      auth: { attributes: {}, authenticator: "hub", principalId, principalType: "user" },
      getToken: async () => ({ token: `token-${principalId}` }),
      requireAuth() {
        assert.fail("must not request re-authorization");
      },
      async getSandbox() {
        return Object.assign(
          fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" }, policies, shared),
          {
            async run() {
              inspect?.();
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          },
        );
      },
    });
  // Leave a live rule behind for rui, as a command still running would.
  let ruiRule: GitHubLeaseRule[] = [];
  await user("rui", () => {
    ruiRule = (shared.policy as { allow: Record<string, GitHubLeaseRule[]> }).allow[
      "api.github.com"
    ]!;
  });
  shared.policy = { allow: { "*": [], "api.github.com": ruiRule } } as NetworkPolicy;

  // Another caller's command never gives rui's lease its own token.
  let during: GitHubLeaseRule[] = [];
  await user("alice", () => {
    during = (shared.policy as { allow: Record<string, GitHubLeaseRule[]> }).allow[
      "api.github.com"
    ]!;
  });
  assert.equal(during.length, 1);
  assert.equal(during[0]!.transform[0]!.headers.authorization, "Bearer token-alice");

  // An expired lease is dropped even for the same caller.
  const placeholder = /eve-github-[^$]+/u.exec(ruiRule[0]!.match!.headers![0]!.value!.regex!)![0];
  const [, encoded] = placeholder.replaceAll("\\.", ".").split(".");
  const lease = JSON.parse(Buffer.from(encoded!, "base64url").toString()) as unknown[];
  const stale = `${placeholder.replaceAll("\\.", ".").split(".")[0]}.${Buffer.from(JSON.stringify([0, ...lease.slice(1)])).toString("base64url")}`;
  shared.policy = {
    allow: {
      "*": [],
      "api.github.com": [
        {
          match: {
            headers: [
              {
                key: { exact: "authorization" },
                value: { regex: `^(?:token|Bearer) ${stale.replaceAll(".", "\\.")}$` },
              },
            ],
          },
          transform: [{ headers: { authorization: "<redacted>" } }],
        },
      ],
    },
  };
  await user("rui", () => {
    during = (shared.policy as { allow: Record<string, GitHubLeaseRule[]> }).allow[
      "api.github.com"
    ]!;
  });
  assert.equal(during.length, 1);
  assert.doesNotMatch(JSON.stringify(during), new RegExp(stale.split(".")[1]!, "u"));
  assert.equal(shared.policy, "allow-all");
});

test("re-mints another app command's token with that command's own permissions", async () => {
  const shared = sharedSandbox();
  const minted: (string[] | undefined)[] = [];
  let releaseReader!: () => void;
  const readerHeld = new Promise<void>((resolve) => (releaseReader = resolve));
  let readerStarted = false;
  const tokenOf = (placeholder: string) =>
    (shared.policy as { allow: Record<string, GitHubLeaseRule[]> }).allow["api.github.com"]?.find(
      (rule) =>
        rule.match?.headers?.[0]?.value?.regex?.includes(placeholder.replaceAll(".", "\\.")),
    )?.transform[0]?.headers.authorization;
  let readerPlaceholder = "";
  const execute = (permissions: string[] | undefined, hold: boolean) =>
    executeGitHubShell(
      READ,
      { ...CONFIG, permissions },
      {
        async getConnectToken(_connector, params) {
          const detail = params.authorizationDetails[0]!;
          minted.push(detail.permissions);
          return `token-${detail.permissions?.join("+") ?? "all"}`;
        },
        async getSandbox() {
          return Object.assign(
            fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" }, [], shared),
            {
              async run(input: Parameters<SandboxSession["run"]>[0]) {
                if (hold) {
                  readerPlaceholder = input.env!.GH_TOKEN!;
                  readerStarted = true;
                  await readerHeld;
                }
                return { exitCode: 0, stdout: "", stderr: "" };
              },
            },
          );
        },
      },
    );

  const reader = execute(["pull_requests:read", "contents:read"], true);
  while (!readerStarted) await new Promise(setImmediate);
  await execute(undefined, false);
  // The writer's last write re-minted the reader's lease, with the reader's permissions.
  assert.equal(tokenOf(readerPlaceholder), "Bearer token-contents:read+pull_requests:read");
  assert.deepEqual(minted.at(-1), ["contents:read", "pull_requests:read"]);
  releaseReader();
  await reader;
  assert.equal(shared.policy, "allow-all");
});

test("a stalled rules write keeps the lock until its process's deadline has passed", async () => {
  const shared = sharedSandbox();
  const order: string[] = [];
  let clock = 1_000_000;
  const deadline = clock + 300_000;
  const lease = (label: string) => ({
    placeholder: leasePlaceholder({
      principal: label,
      owner: "vercel",
      name: label,
      permissions: null,
    }),
    token: `token-${label}`,
  });
  const sandbox = () => fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" }, [], shared);
  let stalled!: () => void;
  const stalling = new Promise<void>((resolve) => (stalled = resolve));
  // Writer A stalls in `broker` and never resumes, as when the platform kills its process.
  void withGitHubLease(
    sandbox(),
    lease("a"),
    {
      broker: async () => {
        stalled();
        await new Promise<never>(() => {});
      },
      read: async (box) => readGitHubRules(box),
      tokenFor: async () => null,
      now: () => clock,
      deadline: () => deadline,
    },
    async () => assert.fail("must not run without its rule"),
  );
  await stalling;
  assert.equal(shared.holdSeconds, 330);
  const b = withGitHubLease(
    sandbox(),
    lease("b"),
    {
      broker: async (box, rules) => {
        order.push("b write");
        await CONFIG.broker(box, rules);
      },
      read: async (box) => {
        order.push("b read");
        return readGitHubRules(box);
      },
      tokenFor: async () => null,
      now: () => clock,
    },
    async () => order.push("b runs"),
  );
  clock = deadline - 1;
  for (let tick = 0; tick < 20; tick += 1) await new Promise(setImmediate);
  assert.deepEqual(order, [], "B waits while A's process may still write");
  clock = deadline + 30_001;
  shared.expire!();
  await b;
  assert.deepEqual(order, ["b read", "b write", "b runs", "b read", "b write"]);
});

test("the lock never expires before the deadline plus its margin", () => {
  const now = 1_000_000;
  for (const remaining of [0, 1, 999, 1_000, 59_500, 300_000, 799_999, 3_600_000]) {
    assert.ok(lockSeconds(now, now + remaining) * 1000 >= remaining + 30_000, String(remaining));
  }
  assert.equal(lockSeconds(now, now - 5_000), 30);
  // With no deadline, the lock outlasts the longest Vercel Function.
  assert.equal(lockSeconds(now, undefined), 830);
});

test("git({ github }) keeps app permissions", () => {
  git({
    github: {
      ...CONFIG,
      principalType: "app",
      permissions: ["contents:read"],
    },
  });
  const github = git.config.github as { permissions?: string[] };
  assert.deepEqual(github.permissions, ["contents:read"]);
});

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
  shared: SharedSandbox = sharedSandbox(),
): SandboxSession {
  const sandbox: Pick<SandboxSession, "resolvePath" | "run" | "removePath" | "spawn"> &
    Pick<NetworkPolicySandboxSession, "setNetworkPolicy"> = {
    resolvePath(path: string) {
      if (path === ".") return "/workspace";
      if (path.startsWith("/")) return path;
      return `/workspace/${path}`;
    },
    async run(input: Parameters<SandboxSession["run"]>[0]) {
      runs.push(input);
      return typeof result === "function" ? result(input) : result;
    },
    // The lease lock: `flock` on one file, so only one holder at a time.
    async spawn(input) {
      assert.match(input.command, /flock -w \d+ 9 && echo locked/u);
      const previous = shared.lock;
      let release!: () => void;
      shared.lock = new Promise<void>((resolve) => (release = resolve));
      await previous;
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => (exit = resolve));
      const end = () => {
        shared.expire = undefined;
        release();
        exit();
      };
      shared.expire = end;
      shared.holdSeconds = Number(/exec sleep (\d+)$/u.exec(input.command)?.[1]);
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("locked\n"));
          },
        }),
        stderr: new ReadableStream(),
        async wait() {
          await exited;
          return { exitCode: 0 };
        },
        async kill() {
          end();
        },
      };
    },
    async removePath() {},
    async setNetworkPolicy(policy: NetworkPolicy) {
      policies.push(policy);
      shared.policy = policy;
    },
  };
  sandboxes.set(sandbox, shared);
  return sandbox as NetworkPolicySandboxSession;
}

const sandboxes = new WeakMap<object, SharedSandbox>();

interface SharedSandbox {
  lock: Promise<void>;
  policy: NetworkPolicy;
  /** Ends the current lock holder, as its `sleep` running out would. */
  expire?: () => void;
  /** How long the current lock holder keeps the lock if never released. */
  holdSeconds?: number;
}

/** The state every handle to one sandbox sees, whichever process holds the handle. */
function sharedSandbox(): SharedSandbox {
  return { lock: Promise.resolve(), policy: "allow-all" };
}

/** What the Vercel Sandbox API returns: injected header values redacted, matches as written. */
function readGitHubRules(sandbox: SandboxSession): Record<string, GitHubLeaseRule[]> {
  const policy = sandboxes.get(sandbox)!.policy;
  if (typeof policy === "string" || Array.isArray(policy.allow)) return {};
  return Object.fromEntries(
    Object.entries(policy.allow ?? {})
      .filter(([host]) => host !== "*")
      .map(([host, rules]) => [
        host,
        (rules as GitHubLeaseRule[]).map((rule) => ({
          ...rule,
          transform: rule.transform.map((transform) => ({
            headers: Object.fromEntries(
              Object.keys(transform.headers).map((key) => [key, "<redacted>"]),
            ),
          })),
        })),
      ]),
  );
}

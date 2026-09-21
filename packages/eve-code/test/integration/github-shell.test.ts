import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectTokenParams } from "@vercel/connect";
import type { SandboxSession } from "eve/sandbox";

import {
  executeGitHubShell,
  githubShellApproval,
  parseCommand,
  type GitHubLeaseRule,
  type GitHubShellInput,
} from "../../extension/lib/github-shell.ts";

const CONFIG = {
  connector: "github/citron-compass",
  org: "vercel",
  async broker(
    sandbox: SandboxSession,
    rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
  ) {
    const allow = Object.fromEntries(
      Object.entries(rules ?? {}).map(([host, entries]) => [host, [...entries]]),
    );
    await sandbox.setNetworkPolicy(rules ? { allow: { "*": [], ...allow } } : "allow-all");
  },
};

const READ: GitHubShellInput = {
  command: "gh pr view 2583 --repo vercel/internal-agents",
  description: "Read PR 2583",
  permissions: [{ provider: "github", repositories: ["vercel/internal-agents"], access: "write" }],
};

const WRITE: GitHubShellInput = {
  command: "git push origin HEAD:refs/heads/rui/my-branch",
  description: "Update the existing PR branch",
  permissions: [{ provider: "github", repositories: ["vercel/internal-agents"], access: "write" }],
  workingDirectory: "/workspace/internal-agents",
};

const CLONE: GitHubShellInput = {
  command: "gh repo clone vercel/internal-agents /workspace/internal-agents",
  description: "Clone the repository into the sandbox",
  permissions: [{ provider: "github", repositories: ["vercel/internal-agents"], access: "write" }],
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
  assert.equal(CLONE.permissions[0].access, "write");
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

test("fails closed on invalid permissions, missing commands, env assignments, and shell syntax", () => {
  const readPush = {
    ...WRITE,
    permissions: [{ ...WRITE.permissions[0], access: "read" as const }] as const,
  };
  // @ts-expect-error Exercise runtime rejection of unsupported read-only permissions.
  assert.deepEqual(githubShellApproval(readPush), {
    type: "denied",
    reason: "GitHub App commands require explicit write-capable access.",
  });
  for (const command of [
    "gh",
    "GH_TOKEN=stolen gh auth status",
    "env GH_TOKEN=stolen gh auth status",
    "bash -lc gh",
  ]) {
    const decision = githubShellApproval({ ...WRITE, command });
    assert.equal(typeof decision, "object", command);
    assert.ok((decision as { reason: string }).reason.length > 0);
  }
  for (const command of ["gh auth status | env", "gh auth status; env", "gh auth status > token"]) {
    assert.throws(() => parseCommand(command), /argv syntax/u, command);
  }
});

test("rejects empty or multiple permissions before sandbox access or token minting", async () => {
  for (const permissions of [[], [...READ.permissions, ...READ.permissions]]) {
    const input = { ...READ, permissions };
    assert.deepEqual(githubShellApproval(input), {
      type: "denied",
      reason: "Exactly one GitHub permission is required.",
    });
    await assert.rejects(
      executeGitHubShell(input, CONFIG, {
        async getSandbox() {
          assert.fail("invalid permissions must not access the sandbox");
        },
        async getConnectToken() {
          assert.fail("invalid permissions must not mint a token");
        },
      }),
      /Exactly one GitHub permission is required/u,
    );
  }
});

test("mints a repository-scoped token only during execution and redacts output", async () => {
  const tokenCalls: Array<{ connector: string; params: ConnectTokenParams }> = [];
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  const policies: Parameters<SandboxSession["setNetworkPolicy"]>[0][] = [];
  const output = await executeGitHubShell(WRITE, CONFIG, {
    async getConnectToken(connector, params) {
      tokenCalls.push({ connector, params });
      return "secret-token";
    },
    async getSandbox() {
      return fakeSandbox(
        runs,
        (run) => {
          const stdout = run.command.includes("realpath -e -- '/workspace/internal-agents'")
            ? "/workspace/internal-agents\n"
            : run.command.includes("realpath -e")
              ? "/workspace\n"
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
  assert.equal(runs.length, 5);
  assert.match(runs[3]?.command ?? "", /git remote get-url --push origin/u);
  assert.match(
    runs[4]?.command ?? "",
    /^cd '\/workspace\/internal-agents' && exec 'git' '-c' 'protocol\.allow=never' '-c' 'protocol\.https\.allow=always' 'push' 'https:\/\/github\.com\/vercel\/internal-agents\.git'/u,
  );
  assert.equal(runs[4]?.env?.GH_TOKEN, undefined);
  assert.match(runs[4]?.env?.GIT_CONFIG_VALUE_0 ?? "", /^Authorization: Basic /u);
  assert.doesNotMatch(JSON.stringify(runs[4]?.env), /secret-token/u);
  assert.equal(runs[4]?.env?.GIT_CONFIG_VALUE_1, "/dev/null");
  assert.match(JSON.stringify(policies[0]), /secret-token/u);
  assert.equal(policies[1], "allow-all");
  assert.equal(output.stdout, "pushed [redacted]");
});

test("runs gh auth token with only the placeholder credential and redacts injected secrets", async () => {
  const runs: Parameters<SandboxSession["run"]>[0][] = [];
  const policies: Parameters<SandboxSession["setNetworkPolicy"]>[0][] = [];
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

test("rejects explicit command targets outside the declared repository before minting", async () => {
  for (const command of [
    "gh pr view 2583 --repo vercel/eve",
    "gh pr view 2583 -R vercel/eve",
    "gh pr view 2583 --repo=vercel/eve",
    "gh --repo=vercel/eve pr view 2583",
    "gh repo clone vercel/eve",
    "gh repo view vercel/eve",
    "gh repo fork vercel/eve",
  ]) {
    let tokenRequested = false;
    await assert.rejects(
      executeGitHubShell({ ...READ, command }, CONFIG, {
        async getConnectToken() {
          tokenRequested = true;
          return "token";
        },
        async getSandbox() {
          return fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" });
        },
      }),
      /not in the declared repositories/u,
      command,
    );
    assert.equal(tokenRequested, false, command);
  }
});

test("rejects repositories outside the configured organization before minting", async () => {
  let tokenRequested = false;
  await assert.rejects(
    executeGitHubShell(
      {
        ...READ,
        command: "gh pr view 2583 --repo other/internal-agents",
        permissions: [
          { provider: "github", repositories: ["other/internal-agents"], access: "write" },
        ],
      },
      CONFIG,
      {
        async getConnectToken() {
          tokenRequested = true;
          return "token";
        },
        async getSandbox() {
          return fakeSandbox([], { exitCode: 0, stdout: "", stderr: "" });
        },
      },
    ),
    /outside vercel/u,
  );
  assert.equal(tokenRequested, false);
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
  policies: Parameters<SandboxSession["setNetworkPolicy"]>[0][] = [],
): SandboxSession {
  const sandbox: Pick<
    SandboxSession,
    "id" | "resolvePath" | "run" | "removePath" | "setNetworkPolicy"
  > = {
    id: "sandbox-1",
    resolvePath(path: string) {
      if (path === ".") return "/workspace";
      if (path.startsWith("/")) return path;
      return `/workspace/${path}`;
    },
    async run(input: Parameters<SandboxSession["run"]>[0]) {
      runs.push(input);
      return typeof result === "function" ? result(input) : result;
    },
    async removePath() {},
    async setNetworkPolicy(policy: Parameters<SandboxSession["setNetworkPolicy"]>[0]) {
      policies.push(policy);
    },
  };
  return sandbox as SandboxSession;
}

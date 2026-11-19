import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxSession } from "eve/sandbox";
import { defineTool, offloadSandbox } from "eve/tools";

import { defineGhTool } from "../../extension/lib/gh-tool.ts";
import { executeGitHubShell, type GitHubShellInput } from "../../extension/lib/github-shell.ts";

const CONFIG = {
  connector: "github/citron-compass",
  principalType: "app" as const,
  authorize: () => true,
  async broker() {},
};

const READ: GitHubShellInput = {
  command: "gh api repos/vercel/internal-agents/issues --paginate",
  description: "List issues",
  repository: "vercel/internal-agents",
};

test("offloadSandbox spread over the gh tool saves the output that gh cut to 100 KB", async () => {
  const written: { content: string; path: string }[] = [];
  const stdout = Array.from(
    { length: 3_000 },
    (_, index) => `issue ${index} ${"x".repeat(60)}`,
  ).join("\n");
  const fake: Pick<SandboxSession, "resolvePath" | "run" | "removePath" | "writeTextFile"> = {
    resolvePath: (path: string) => (path === "." ? "/workspace" : path),
    async run() {
      return { exitCode: 0, stdout, stderr: "" };
    },
    async removePath() {},
    async writeTextFile(input: { content: string; path: string }) {
      written.push(input);
    },
  };
  const sandbox = fake as SandboxSession;

  const output = await executeGitHubShell(READ, CONFIG, {
    sessionId: "session-1",
    async getConnectToken() {
      return "token";
    },
    async getSandbox() {
      return sandbox;
    },
  });
  assert.equal(output.truncated, true);

  const gh = defineTool({
    ...defineGhTool(() => CONFIG),
    toModelOutput: offloadSandbox({ maxOutputTokens: 2_000 }),
  });
  const result = await gh.toModelOutput?.(output, {
    callId: "call-1",
    toolName: "gh",
    getSandbox: async () => sandbox,
    defaultModelOutput: (value: unknown) => ({ type: "json", value }),
  } as Parameters<NonNullable<typeof gh.toModelOutput>>[1]);

  assert.equal(written.length, 1);
  assert.equal(written[0]!.path, "/tmp/.eve/tool-results/gh-call-1.json");
  assert.deepEqual(JSON.parse(written[0]!.content), output);
  assert.match(JSON.stringify(result), /\/tmp\/\.eve\/tool-results\/gh-call-1\.json/);
  assert.ok(JSON.stringify(result).length < 2_000);
});

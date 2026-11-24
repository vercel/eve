import assert from "node:assert/strict";
import test from "node:test";

import extension from "../../extension/extension.ts";
import { parseCommand } from "../../extension/lib/github-shell.ts";
import { resolvePrefetchTarget } from "../../extension/lib/prefetch.ts";

test("extracts target repository paths for clone and ref-changing commands inside the workspace", () => {
  const cases: ReadonlyArray<{
    readonly command: string;
    readonly workingDirectory?: string;
    readonly workspaceRoot?: string;
    readonly repository?: string;
    readonly expected: string | null;
  }> = [
    {
      command: "git clone https://github.com/vercel/eve.git",
      expected: "/workspace/eve",
    },
    {
      command:
        "git clone --filter=blob:none --no-checkout https://github.com/vercel/eve.git custom",
      expected: "/workspace/custom",
    },
    {
      command:
        "git clone --filter blob:none -b main --depth 1 -o upstream --reference /ref -c core.autocrlf=false https://github.com/vercel/eve.git",
      expected: "/workspace/eve",
    },
    {
      command: "git clone -- https://github.com/vercel/eve.git /workspace/explicit",
      expected: "/workspace/explicit",
    },
    {
      command: "git -C sub -c protocol.version=2 clone git@github.com:vercel/eve.git",
      expected: "/workspace/sub/eve",
    },
    {
      command: "gh repo clone vercel/eve",
      expected: "/workspace/eve",
    },
    {
      command: "gh repo clone vercel/eve custom-eve",
      expected: "/workspace/custom-eve",
    },
    {
      command: "gh repo clone vercel/eve -- --filter=blob:none --no-checkout --depth 1",
      expected: "/workspace/eve",
    },
    {
      command: "gh repo clone vercel/eve custom-eve -- --filter=blob:none --branch main",
      expected: "/workspace/custom-eve",
    },
    {
      command: "gh repo clone vercel/eve -u upstream -- --depth 1",
      expected: "/workspace/eve",
    },
    {
      command: "git -C repo checkout main",
      expected: "/workspace/repo",
    },
    {
      command: "git -Crepo -c advice.detachedHead=false switch -c feature",
      expected: "/workspace/repo",
    },
    {
      command: "git -C sub -C nested fetch origin",
      expected: "/workspace/sub/nested",
    },
    {
      command: "git pull origin main",
      workingDirectory: "/workspace/eve",
      expected: "/workspace/eve",
    },
    {
      command: "git sparse-checkout set packages/eve",
      workingDirectory: "/workspace/eve",
      expected: "/workspace/eve",
    },
    {
      command: "git -C /tmp/other fetch",
      expected: null,
    },
    {
      command: "git -C ../outside checkout main",
      expected: null,
    },
    {
      command: "gh repo clone org/repo ../outside",
      expected: null,
    },
    {
      command: "gh repo clone vercel/eve /workspace-other/eve",
      expected: null,
    },
    {
      command: "git clone https://github.com/vercel/eve.git /tmp/outside",
      expected: null,
    },
    {
      command: "gh pr view 123 --repo vercel/eve",
      expected: null,
    },
    {
      command: "gh issue list --repo vercel/eve",
      expected: null,
    },
    {
      command: "gh repo view vercel/eve",
      expected: null,
    },
    {
      command: "git push origin main",
      expected: null,
    },
    {
      command: "git status",
      expected: null,
    },
    {
      command: "gh-signed-commit --repo vercel/eve --branch feat -m msg",
      expected: null,
    },
  ];

  for (const {
    command,
    workingDirectory = "/workspace",
    workspaceRoot = "/workspace",
    repository,
    expected,
  } of cases) {
    assert.equal(
      resolvePrefetchTarget(parseCommand(command), workingDirectory, workspaceRoot, repository),
      expected,
      command,
    );
  }
});

test("extension config validates prefetchFiles as safe relative paths", () => {
  const base = {
    connector: "github/acme-bot",
    authorize: () => true,
    broker: async () => {},
    principalType: "app" as const,
  };

  for (const prefetchFiles of [
    undefined,
    [] as const,
    ["AGENTS.md", "CLAUDE.md", ".github/pull_request_template.md", "docs/AGENTS.md"] as const,
  ]) {
    assert.doesNotThrow(() => extension({ github: { ...base, prefetchFiles } }));
  }

  for (const invalid of [
    "",
    "   ",
    "/etc/passwd",
    "../secret",
    "a/../b",
    "..",
    ".",
    "./AGENTS.md",
    "docs/",
    "docs//AGENTS.md",
    "docs\\AGENTS.md",
    "AGENTS.md\n",
    "AGENTS.md\r",
    "AGENTS.md\0",
  ]) {
    assert.throws(
      () => extension({ github: { ...base, prefetchFiles: [invalid] } }),
      /prefetchFiles/u,
      JSON.stringify(invalid),
    );
  }
});

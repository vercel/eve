import assert from "node:assert/strict";
import test from "node:test";

import extension from "../../extension/extension.ts";
import { parseCommand } from "../../extension/lib/github-shell.ts";
import { buildPrefetchCommand, resolvePrefetchTarget } from "../../extension/lib/prefetch.ts";

test("extracts target repository paths for partial clone and ref-changing commands inside the workspace", () => {
  const cases: ReadonlyArray<{
    readonly command: string;
    readonly workingDirectory?: string;
    readonly workspaceRoot?: string;
    readonly repository?: string;
    readonly expected: string | null;
  }> = [
    {
      command: "git clone --filter=blob:none https://github.com/vercel/eve.git",
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
      command:
        "git clone --filter=blob:none -- https://github.com/vercel/eve.git /workspace/explicit",
      expected: "/workspace/explicit",
    },
    {
      command:
        "git -C sub -c protocol.version=2 clone --filter=blob:none git@github.com:vercel/eve.git",
      expected: "/workspace/sub/eve",
    },
    {
      command: "gh repo clone vercel/eve -- --filter=blob:none",
      expected: "/workspace/eve",
    },
    {
      command: "gh repo clone vercel/eve custom-eve -- --filter=blob:none",
      expected: "/workspace/custom-eve",
    },
    {
      command: "gh repo clone vercel/eve -- --filter=blob:none --no-checkout --depth 1",
      expected: "/workspace/eve",
    },
    {
      command: "gh repo clone vercel/eve custom-eve -- --filter blob:none --branch main",
      expected: "/workspace/custom-eve",
    },
    {
      command: "gh repo clone vercel/eve -u upstream -- --filter=blob:none --depth 1",
      expected: "/workspace/eve",
    },
    {
      command: "git clone https://github.com/vercel/eve",
      expected: null,
    },
    {
      command: "git clone https://github.com/vercel/eve.git",
      expected: null,
    },
    {
      command: "git clone --depth 1 https://github.com/vercel/eve.git",
      expected: null,
    },
    {
      command: "git clone --sparse https://github.com/vercel/eve.git",
      expected: null,
    },
    {
      command: "git clone -- https://github.com/vercel/eve.git /workspace/explicit",
      expected: null,
    },
    {
      command: "git clone -b --filter https://github.com/vercel/eve.git",
      expected: null,
    },
    {
      command: "git clone --filter=blob:none --no-filter https://github.com/vercel/eve.git",
      expected: null,
    },
    {
      command: "gh repo clone vercel/eve",
      expected: null,
    },
    {
      command: "gh repo clone vercel/eve custom-eve",
      expected: null,
    },
    {
      command: "gh repo clone vercel/eve -u upstream -- --depth 1",
      expected: null,
    },
    {
      command: "gh repo clone vercel/eve -- -b --filter",
      expected: null,
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
      command: "gh repo clone org/repo ../outside -- --filter=blob:none",
      expected: null,
    },
    {
      command: "gh repo clone vercel/eve /workspace-other/eve -- --filter=blob:none",
      expected: null,
    },
    {
      command: "git clone --filter=blob:none https://github.com/vercel/eve.git /tmp/outside",
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
    {
      command: "git clone --filter=blob:none https://github.com/vercel/eve.git",
      workingDirectory: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      expected: "C:/workspace/eve",
    },
    {
      command: "git -C sub/nested fetch origin",
      workingDirectory: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      expected: "C:/workspace/sub/nested",
    },
    {
      command: "git -C C:/workspace/repo checkout main",
      workingDirectory: "c:/workspace",
      workspaceRoot: "C:/workspace",
      expected: "C:/workspace/repo",
    },
    {
      command: "git -C ../outside fetch origin",
      workingDirectory: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      expected: null,
    },
    {
      command: "git -C D:/workspace/eve fetch origin",
      workingDirectory: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      expected: null,
    },
    {
      command: "gh repo clone vercel/eve custom -- --filter=blob:none",
      workingDirectory: "C:\\workspace",
      workspaceRoot: "C:\\workspace",
      expected: "C:/workspace/custom",
    },
    {
      command: "git pull origin main",
      workingDirectory: "C:\\workspace\\eve",
      workspaceRoot: "C:\\workspace",
      expected: "C:/workspace/eve",
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
    "AGENTS.md\t",
    "AGENTS\x07.md",
    "AGENTS\x1b.md",
    "AGENTS\x7f.md",
  ]) {
    assert.throws(
      () => extension({ github: { ...base, prefetchFiles: [invalid] } }),
      /prefetchFiles/u,
      JSON.stringify(invalid),
    );
  }
});

test("buildPrefetchCommand enforces workspace boundaries for Windows drive paths and hardens git invocations", () => {
  assert.equal(buildPrefetchCommand("D:\\workspace\\eve", "C:\\workspace", ["AGENTS.md"]), null);
  assert.equal(
    buildPrefetchCommand("C:\\workspace-other\\eve", "C:\\workspace", ["AGENTS.md"]),
    null,
  );

  const command = buildPrefetchCommand("C:\\workspace\\eve", "C:\\workspace", ["AGENTS.md"]);
  assert.ok(command);
  assert.match(
    command,
    /GIT_ALLOW_PROTOCOL= git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C 'C:\\workspace\\eve' rev-parse --show-toplevel/u,
  );
  assert.match(
    command,
    /GIT_ALLOW_PROTOCOL= git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C "\$top" config --get-regexp/u,
  );
  assert.match(
    command,
    /GIT_ALLOW_PROTOCOL= GIT_NO_LAZY_FETCH=1 git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -c core\.quotePath=false --literal-pathspecs -C "\$top" ls-tree/u,
  );
  assert.match(
    command,
    /GIT_ALLOW_PROTOCOL= GIT_NO_LAZY_FETCH=1 git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C "\$top" cat-file -e/u,
  );
  assert.match(
    command,
    /env GIT_ALLOW_PROTOCOL=https GIT_TERMINAL_PROMPT=0 git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -c credential\.helper= -C "\$top" cat-file --batch-check/u,
  );
});

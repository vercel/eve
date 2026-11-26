import assert from "node:assert/strict";
import test from "node:test";

import extension from "../../extension/extension.ts";
import { parseCommand } from "../../extension/lib/github-shell.ts";
import { buildPrefetchCommand, resolvePrefetchTarget } from "../../extension/lib/prefetch.ts";

test("extracts target repository paths for partial clone and ref-changing commands inside the workspace", () => {
  const cases: ReadonlyArray<{
    readonly command: string;
    readonly workingDirectory?: string;
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
      command: "gh repo clone vercel/eve custom-eve -- --filter blob:none --branch main",
      expected: "/workspace/custom-eve",
    },
    {
      command: "gh repo clone vercel/eve -u upstream -- --filter=blob:none --depth 1",
      expected: "/workspace/eve",
    },
    {
      command: "git clone --depth 1 https://github.com/vercel/eve.git",
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
      command: "gh repo clone vercel/eve -u upstream -- --depth 1",
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
      command: "git -C /tmp/other fetch",
      expected: null,
    },
    {
      command: "git -C ../outside checkout main",
      expected: null,
    },
    {
      command: "gh repo clone vercel/eve /workspace-other/eve -- --filter=blob:none",
      expected: null,
    },
    {
      command: "gh pr view 123 --repo vercel/eve",
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
      command: "gh-signed-commit --repo vercel/eve --branch feat -m msg",
      expected: null,
    },
  ];

  for (const { command, workingDirectory = "/workspace", expected } of cases) {
    assert.equal(
      resolvePrefetchTarget(parseCommand(command), workingDirectory, "/workspace"),
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
    "   ",
    "/etc/passwd",
    "../secret",
    "./AGENTS.md",
    "docs/",
    "docs\\AGENTS.md",
    "AGENTS.md\n",
    "AGENTS\x7f.md",
  ]) {
    assert.throws(
      () => extension({ github: { ...base, prefetchFiles: [invalid] } }),
      /prefetchFiles/u,
      JSON.stringify(invalid),
    );
  }
});

test("buildPrefetchCommand returns null outside the workspace or without valid files", () => {
  assert.equal(buildPrefetchCommand("/workspace-other/eve", "/workspace", ["AGENTS.md"]), null);
  assert.equal(buildPrefetchCommand("/workspace/eve", "/workspace", ["../secret"]), null);
  assert.ok(buildPrefetchCommand("/workspace/eve", "/workspace", ["AGENTS.md"]));
});

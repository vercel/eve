import assert from "node:assert/strict";
import test from "node:test";

(globalThis as Record<symbol, unknown>)[Symbol.for("eve.ext-config-scope")] =
  "eve-code-extension-config-test";
const { default: extension } = await import("../../extension/extension.ts");

test("accepts no connectors", () => {
  extension({});
  assert.deepEqual(extension.config, {});
});

test("applies firewall defaults independently", () => {
  extension({
    vercel: { connector: "vercel/acme-bot" },
  });
  assert.equal(extension.config.vercel?.delivery, "firewall");
});

test("rejects empty connector names", () => {
  assert.throws(() => extension({ vercel: { connector: "" } }), /Invalid extension config/u);
});

test("rejects retired github config instead of silently ignoring credentials", () => {
  assert.throws(
    // @ts-expect-error GitHub belongs to the git extension.
    () => extension({ github: { connector: "github/acme", org: "acme" } }),
    /Invalid extension config/u,
  );
});

test("rejects the removed worker option with a migration hint", () => {
  const hint =
    "Invalid extension config: eve-code no longer ships a worker subagent; delegate with the built-in `agent` tool and remove the `worker` option.";
  const worker = { model: "openai/gpt-5.4", reasoning: "high" };
  const cases: readonly (readonly [object, string])[] = [
    [{ worker }, hint],
    [{ worker, github: {} }, `${hint} Also unrecognized: "github".`],
  ];
  for (const [config, message] of cases) {
    assert.throws(() => extension(config as Parameters<typeof extension>[0]), { message });
  }
});

test("accepts valid repositories config with rules, specs, syncAfter, and caps", () => {
  const customTool = {
    description: "Sync workspace",
    inputSchema: {},
    execute: () => ({ ok: true }),
  };
  extension({
    repositories: {
      roots: [".", "repos", "packages/app"],
      instructions: [["AGENTS.md", "CLAUDE.md"], "docs/GUIDE.md"],
      scopedInstructions: true,
      discoverOnStart: "on-sandbox-use",
      rules: [
        {
          match: "vercel/*",
          files: ["CONTRIBUTING.md", ["DOCS.md", "README.md"]],
          onEnter: () => ({ instructions: "Follow Vercel conventions." }),
        },
        {
          match: /^acme\//u,
        },
        {
          match: (repo) => repo.sparse,
        },
      ],
      syncAfter: [customTool as never],
      maxFileBytes: 32_000,
      maxTotalBytes: 128_000,
    },
  });
  assert.equal(extension.config.repositories?.discoverOnStart, "on-sandbox-use");
  assert.equal(extension.config.repositories?.maxFileBytes, 32_000);
  assert.equal(extension.config.repositories?.rules?.length, 3);
});

test("rejects path traversal, invalid byte caps, and unknown keys inside repositories config", () => {
  const invalidCases: readonly object[] = [
    { repositories: { roots: ["../escape"] } },
    { repositories: { roots: ["/etc"] } },
    { repositories: { roots: ["a\\b"] } },
    { repositories: { instructions: ["../AGENTS.md"] } },
    { repositories: { instructions: ["/AGENTS.md"] } },
    { repositories: { instructions: ["a/./b"] } },
    { repositories: { instructions: [[]] } },
    { repositories: { rules: [{ files: ["../secret.md"] }] } },
    { repositories: { maxFileBytes: 0 } },
    { repositories: { maxFileBytes: 1.5 } },
    { repositories: { maxTotalBytes: -10 } },
    { repositories: { unknownFlag: true } },
    { repositories: { rules: [{ unknownRuleKey: true }] } },
  ];
  for (const invalid of invalidCases) {
    assert.throws(
      () => extension(invalid as Parameters<typeof extension>[0]),
      /Invalid extension config/u,
      JSON.stringify(invalid),
    );
  }
});

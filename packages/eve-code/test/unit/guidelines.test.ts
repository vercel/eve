import assert from "node:assert/strict";
import test from "node:test";
import { discoverGuidelines, type SandboxLike } from "../../extension/lib/guidelines.ts";

/** Sandbox double: serves a canned ls-files listing and file contents. */
function fakeSandbox(input: {
  readonly files?: readonly string[];
  readonly contents?: Readonly<Record<string, string>>;
  readonly listExitCode?: number;
}): SandboxLike {
  return {
    run({ command }) {
      if (command.includes("ls-files")) {
        return Promise.resolve({
          exitCode: input.listExitCode ?? 0,
          stdout: (input.files ?? []).join("\n"),
          stderr: "",
        });
      }
      const match = /head -c (\d+) "(.+)"/u.exec(command);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        const path = match[2].replace(/^\/repo\//u, "");
        const content = input.contents?.[path] ?? "";
        return Promise.resolve({
          exitCode: 0,
          stdout: content.slice(0, Number.parseInt(match[1], 10)),
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: `unexpected: ${command}` });
    },
  };
}

test("AGENTS.md beats CLAUDE.md per directory, in either listing order", async () => {
  for (const files of [
    ["AGENTS.md", "CLAUDE.md", "packages/web/CLAUDE.md", "packages/web/AGENTS.md"],
    ["CLAUDE.md", "AGENTS.md", "packages/web/AGENTS.md", "packages/web/CLAUDE.md"],
  ]) {
    const result = await discoverGuidelines(
      fakeSandbox({ files, contents: { "AGENTS.md": "# root rules" } }),
      "/repo",
    );
    assert.equal(result.rootPath, "AGENTS.md");
    assert.equal(result.root, "# root rules");
    assert.deepEqual(result.nested, ["packages/web/AGENTS.md"]);
  }
});

test("CLAUDE.md is used when it is all a directory has", async () => {
  const result = await discoverGuidelines(
    fakeSandbox({
      files: ["CLAUDE.md", "docs/AGENTS.md"],
      contents: { "CLAUDE.md": "claude-only root" },
    }),
    "/repo",
  );
  assert.equal(result.rootPath, "CLAUDE.md");
  assert.equal(result.root, "claude-only root");
  assert.deepEqual(result.nested, ["docs/AGENTS.md"]);
});

test("nested paths sort shallowest first", async () => {
  const result = await discoverGuidelines(
    fakeSandbox({
      files: ["a/b/c/AGENTS.md", "a/AGENTS.md", "a/b/AGENTS.md"],
    }),
    "/repo",
  );
  assert.equal(result.rootPath, null);
  assert.deepEqual(result.nested, ["a/AGENTS.md", "a/b/AGENTS.md", "a/b/c/AGENTS.md"]);
});

test("oversized root content is capped with an explicit truncation marker", async () => {
  const big = "x".repeat(13_000);
  const result = await discoverGuidelines(
    fakeSandbox({ files: ["AGENTS.md"], contents: { "AGENTS.md": big } }),
    "/repo",
  );
  assert.equal(result.rootTruncated, true);
  assert.ok(result.root !== null);
  assert.ok(result.root.length <= 12_000 + 100);
  assert.ok(result.root.includes("[truncated: read AGENTS.md"));
});

test("content exactly at the cap passes through unmarked", async () => {
  const exact = "y".repeat(12_000);
  const result = await discoverGuidelines(
    fakeSandbox({ files: ["AGENTS.md"], contents: { "AGENTS.md": exact } }),
    "/repo",
  );
  assert.equal(result.rootTruncated, false);
  assert.equal(result.root, exact);
});

test("no guideline files and listing failures both degrade to none", async () => {
  const empty = await discoverGuidelines(fakeSandbox({ files: [] }), "/repo");
  assert.deepEqual(empty, { rootPath: null, root: null, rootTruncated: false, nested: [] });

  const failed = await discoverGuidelines(fakeSandbox({ listExitCode: 1 }), "/repo");
  assert.deepEqual(failed, { rootPath: null, root: null, rootTruncated: false, nested: [] });
});

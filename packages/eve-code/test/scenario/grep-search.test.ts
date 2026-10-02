import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_GREP_COMMAND_BYTES,
  MAX_GREP_LINE_BYTES,
  MAX_GREP_RETURN_BYTES,
  assertWorkspacePath,
  buildPosixGrepCommand,
  buildRipgrepCommand,
  buildSearchCommand,
  effectiveLimit,
  effectiveOutputMode,
  executeGrepSearch,
  processGrepOutput,
  shouldUseFixedStrings,
} from "../../extension/lib/grep-search.ts";

test("defaults to files_with_matches and a tight row cap", () => {
  assert.equal(effectiveOutputMode(undefined), "files_with_matches");
  assert.equal(effectiveLimit(undefined), 50);
  assert.equal(effectiveLimit(0), 1);
  assert.equal(effectiveLimit(9_000), 200);
});

test("uses fixed strings for identifiers and regex for patterns with metacharacters", () => {
  assert.equal(shouldUseFixedStrings("defineTool", undefined), true);
  assert.equal(shouldUseFixedStrings("PaymentFailedError", undefined), true);
  assert.equal(shouldUseFixedStrings("import.*PaymentService", undefined), false);
  assert.equal(shouldUseFixedStrings("defineTool", false), false);
  assert.equal(shouldUseFixedStrings("a.b", true), true);
});

test("ripgrep discovery stops at the first hit per file", () => {
  const command = buildRipgrepCommand({
    contextLines: 0,
    glob: "*.ts",
    ignoreCase: false,
    limit: 50,
    literal: true,
    outputMode: "files_with_matches",
    path: "/workspace/packages/eve",
    pattern: "defineTool",
  });
  assert.match(command, /^rg /u);
  assert.match(command, /--files-with-matches/u);
  assert.match(command, /--max-count 1/u);
  assert.match(command, /--fixed-strings/u);
  assert.match(command, /--glob '\*\.ts'/u);
  assert.doesNotMatch(command, /--line-number/u);
});

test("ripgrep content mode keeps line numbers and a per-file cap", () => {
  const command = buildRipgrepCommand({
    contextLines: 2,
    glob: undefined,
    ignoreCase: true,
    limit: 20,
    literal: false,
    outputMode: "content",
    path: "/workspace",
    pattern: "log.*Error",
  });
  assert.match(command, /--line-number/u);
  assert.match(command, /--context 2/u);
  assert.match(command, /--max-count 20/u);
  assert.match(command, /--ignore-case/u);
  assert.doesNotMatch(command, /--fixed-strings/u);
  assert.doesNotMatch(command, /--files-with-matches/u);
});

test("quotes patterns so they cannot break out of the sandbox command", () => {
  const command = buildRipgrepCommand({
    contextLines: 0,
    glob: undefined,
    ignoreCase: false,
    limit: 10,
    literal: true,
    outputMode: "files_with_matches",
    path: "/workspace",
    pattern: "it's a trap",
  });
  assert.match(command, /'it'"'"'s a trap'/u);
});

test("posix fallback lists files without installing ripgrep", () => {
  const command = buildPosixGrepCommand({
    contextLines: 0,
    glob: "*.md",
    ignoreCase: false,
    limit: 10,
    literal: true,
    outputMode: "files_with_matches",
    path: "/workspace",
    pattern: "TODO",
  });
  assert.match(command, /^grep -r /u);
  assert.match(command, / -l /u);
  assert.match(command, /--include='\*\.md'/u);
});

test("search command prefers rg when it is on PATH", () => {
  const command = buildSearchCommand({
    contextLines: 0,
    glob: undefined,
    ignoreCase: false,
    limit: 10,
    literal: true,
    outputMode: "count",
    path: "/workspace",
    pattern: "TODO",
  });
  assert.match(command, /command -v rg/u);
  assert.match(command, /--count/u);
  assert.match(command, /else/u);
});

test("workspace path checks reject escapes before the sandbox runs", () => {
  assert.equal(assertWorkspacePath("/workspace", undefined), "/workspace");
  assert.equal(assertWorkspacePath("/workspace/src", "src"), "/workspace/src");
  assert.throws(
    () => assertWorkspacePath("/etc/passwd", "/etc/passwd"),
    /must stay under \/workspace/u,
  );
  assert.throws(() => assertWorkspacePath("/workspace/src", "../etc"), /must not contain '\.\.'/u);
});

test("processGrepOutput caps rows and drops zero-count files", () => {
  const files = processGrepOutput({
    limit: 2,
    outputMode: "files_with_matches",
    path: "/workspace",
    stdout: "a.ts\nb.ts\nc.ts\n",
  });
  assert.equal(files.matchCount, 2);
  assert.equal(files.truncated, true);
  assert.match(files.content, /a\.ts\nb\.ts/u);
  assert.match(files.content, /Output truncated/u);

  const counts = processGrepOutput({
    limit: 10,
    outputMode: "count",
    path: "/workspace",
    stdout: "a.ts:3\nb.ts:0\nc.ts:1\n",
  });
  assert.equal(counts.matchCount, 4);
  assert.equal(counts.truncated, false);
  assert.equal(counts.content, "a.ts:3\nc.ts:1");

  const empty = processGrepOutput({
    limit: 10,
    outputMode: "content",
    path: "/workspace",
    stdout: "",
  });
  assert.equal(empty.matchCount, 0);
  assert.equal(empty.content, "No matches found");
});

test("executeGrepSearch runs the discovery command and stays under /workspace", async () => {
  let command = "";
  const result = await executeGrepSearch(
    { pattern: "defineTool", path: "packages/eve" },
    {
      resolvePath: (value) => (value.startsWith("/") ? value : `/workspace/${value}`),
      async run(input) {
        if (input.command.startsWith("realpath")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: input.command.includes("packages/eve")
              ? "/workspace/packages/eve\0"
              : "/workspace\0",
          };
        }
        command = input.command;
        return { exitCode: 0, stderr: "", stdout: "packages/eve/src/index.ts\n" };
      },
    },
  );
  assert.match(command, /--files-with-matches/u);
  assert.match(command, /--max-count 1/u);
  assert.match(command, /--fixed-strings/u);
  assert.match(command, /\/workspace\/packages\/eve/u);
  assert.equal(result.matchCount, 1);
  assert.equal(result.outputMode, "files_with_matches");
  assert.equal(result.path, "/workspace/packages/eve");
});

test("executeGrepSearch surfaces sandbox failures instead of an empty hit list", async () => {
  await assert.rejects(
    executeGrepSearch(
      { pattern: "[", literal: false },
      {
        resolvePath: () => "/workspace",
        async run({ command }) {
          if (command.startsWith("realpath")) {
            return { exitCode: 0, stderr: "", stdout: "/workspace\0" };
          }
          return { exitCode: 2, stderr: "regex parse error", stdout: "" };
        },
      },
    ),
    /regex parse error/u,
  );
});

test("content protocol distinguishes matches from context lines", () => {
  const result = processGrepOutput({
    limit: 10,
    outputMode: "content",
    path: "/workspace",
    stdout: [
      "/workspace/a.ts\u00001-before",
      "/workspace/a.ts\u00002:hit",
      "/workspace/a.ts\u00003-after:99:not-a-match",
      "--",
      "/workspace/b.ts\u000010:another hit",
      "",
    ].join("\n"),
  });

  assert.equal(result.matchCount, 2);
  assert.equal(result.truncated, false);
  assert.equal(
    result.content,
    [
      "/workspace/a.ts-1-before",
      "/workspace/a.ts:2:hit",
      "/workspace/a.ts-3-after:99:not-a-match",
      "--",
      "/workspace/b.ts:10:another hit",
    ].join("\n"),
  );
});

test("search command bounds combined command output before sandbox buffering", () => {
  const command = buildSearchCommand({
    contextLines: 0,
    glob: undefined,
    ignoreCase: false,
    limit: 10,
    literal: true,
    outputMode: "content",
    path: "/workspace",
    pattern: "needle",
  });

  assert.match(command, new RegExp(`2>&1 \\| head -c ${MAX_GREP_COMMAND_BYTES + 1}`, "u"));
  assert.match(command, /PIPESTATUS\[0\]/u);
});

test("returned output has per-line and total UTF-8 byte bounds", () => {
  const oversizedLine = "🙂".repeat(MAX_GREP_LINE_BYTES);
  const result = processGrepOutput({
    commandTruncated: true,
    limit: 10,
    outputMode: "files_with_matches",
    path: "/workspace",
    stdout: `${oversizedLine}\nsmall.ts\n`,
  });

  assert.equal(result.matchCount, 2);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content) <= MAX_GREP_RETURN_BYTES);
  assert.ok(Buffer.byteLength(result.content.split("\n")[0] ?? "") <= MAX_GREP_LINE_BYTES);
  assert.match(result.content, /Output truncated/u);
});

test("total byte truncation counts only rows retained in content", () => {
  const rows = Array.from({ length: 200 }, (_, index) => `${index}-${"x".repeat(1_000)}`);
  const result = processGrepOutput({
    limit: 200,
    outputMode: "files_with_matches",
    path: "/workspace",
    stdout: `${rows.join("\n")}\n`,
  });
  const returnedRows = result.content.split("\n\n[Output truncated", 1)[0]?.split("\n").length;

  assert.equal(result.truncated, true);
  assert.equal(result.matchCount, returnedRows);
  assert.ok(result.matchCount < rows.length);
  assert.ok(Buffer.byteLength(result.content) <= MAX_GREP_RETURN_BYTES);
});

test("executeGrepSearch rejects a symlink target whose realpath escapes the workspace", async () => {
  let runCount = 0;
  await assert.rejects(
    executeGrepSearch(
      { pattern: "secret", path: "linked" },
      {
        resolvePath: (value) => (value ? `/workspace/${value}` : "/workspace"),
        async run() {
          runCount += 1;
          return {
            exitCode: 0,
            stderr: "",
            stdout: runCount === 1 ? "/workspace\0" : "/etc\0",
          };
        },
      },
    ),
    /resolves outside \/workspace/u,
  );
  assert.equal(runCount, 2);
});

test("ripgrep and fallback content modes emit an unambiguous filename protocol", () => {
  const input = {
    contextLines: 2,
    glob: undefined,
    ignoreCase: false,
    limit: 10,
    literal: true,
    outputMode: "content" as const,
    path: "/workspace",
    pattern: "needle",
  };

  assert.match(buildRipgrepCommand(input), /--with-filename --null/u);
  assert.match(buildPosixGrepCommand(input), /-n -H -Z/u);
});

test("tool description is truthful about fallback gitignore behavior", async () => {
  const source = await readFile(new URL("../../extension/tools/grep.ts", import.meta.url), "utf8");
  assert.match(source, /POSIX fallback does not read \.gitignore/u);
});

test("worker remounts the extension grep instead of eve's provided tool", async () => {
  const source = await readFile(
    new URL("../../extension/subagents/worker/tools/grep.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\.\/\.\.\/\.\.\/tools\/grep\.ts"/u);
  assert.doesNotMatch(source, /eve\/tools\/grep/u);
});

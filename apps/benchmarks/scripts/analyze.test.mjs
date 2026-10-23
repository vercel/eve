import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseTranscript } from "@vercel/agent-eval";

const script = new URL("./analyze.mjs", import.meta.url);
const docs = "/vercel/sandbox/node_modules/eve/docs";

// One raw transcript per native harness, in the shape each harness emits.
const runs = {
  "claude-code": [
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: `${docs}/README.md` } },
          { type: "tool_use", name: "Read", input: { file_path: `${docs}/tools/overview.mdx` } },
        ],
      },
    },
  ],
  codex: [
    {
      type: "item.started",
      item: { type: "command_execution", command: `bash -lc 'cat ${docs}/README.md'` },
    },
    {
      type: "item.started",
      item: { type: "command_execution", command: `bash -lc 'sed -n 1,80p ${docs}/README.md'` },
    },
  ],
  opencode: [
    {
      type: "tool_use",
      part: {
        tool: "read",
        state: { status: "completed", input: { filePath: `${docs}/README.md` }, output: "" },
      },
    },
    {
      type: "tool_use",
      part: {
        tool: "bash",
        state: { status: "completed", input: { command: `ls ${docs}/channels/` }, output: "" },
      },
    },
  ],
};

test("aggregates docs reads across harnesses and lists unread pages", () => {
  const root = mkdtempSync(join(tmpdir(), "eve-benchmark-analyze-"));
  try {
    for (const [harness, events] of Object.entries(runs)) {
      const runPath = join(root, `author-${harness}`, "run-1");
      mkdirSync(runPath, { recursive: true });
      const raw = events.map((event) => JSON.stringify(event)).join("\n");
      const transcript = parseTranscript(raw, `vercel-ai-gateway/${harness}`);
      writeFileSync(join(runPath, "transcript.json"), JSON.stringify(transcript));
      writeFileSync(join(runPath, "transcript-raw.jsonl"), raw);
      writeFileSync(join(runPath, "result.json"), JSON.stringify({ status: "passed" }));
    }

    const usage = JSON.parse(
      execFileSync(process.execPath, [script.pathname, root, "--docs", "--json"], {
        encoding: "utf8",
      }),
    );

    assert.equal(usage.runs, 3);
    assert.equal(usage.runsWithDocs, 3);
    assert.deepEqual(
      usage.pages.map(({ page, runs, reads }) => ({ page, runs, reads })),
      [
        { page: "README.md", runs: 3, reads: 4 },
        { page: "channels/*", runs: 1, reads: 1 },
        { page: "tools/overview.mdx", runs: 1, reads: 1 },
      ],
    );
    assert.ok(!usage.unread.includes("README.md"));
    assert.ok(!usage.unread.includes("tools/overview.mdx"));
    assert.ok(usage.unread.includes("getting-started.mdx"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

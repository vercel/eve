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
        usage: { input_tokens: 10, output_tokens: 3 },
        content: [
          { type: "text", text: "Reading the docs." },
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
    { type: "item.completed", item: { type: "agent_message", text: "Done." } },
    {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 },
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
    { type: "text", part: { text: "Done." } },
    { type: "step_finish", part: { tokens: { input: 10, output: 3, cache: { read: 0 } } } },
  ],
};

function writeRuns(root, transcripts) {
  for (const [harness, events] of Object.entries(transcripts)) {
    const runPath = join(root, `author-${harness}`, "run-1");
    mkdirSync(runPath, { recursive: true });
    const raw = events.map((event) => JSON.stringify(event)).join("\n");
    const transcript = parseTranscript(raw, `vercel-ai-gateway/${harness}`);
    writeFileSync(join(runPath, "transcript.json"), JSON.stringify(transcript));
    writeFileSync(join(runPath, "transcript-raw.jsonl"), raw);
    writeFileSync(join(runPath, "result.json"), JSON.stringify({ status: "passed" }));
  }
}

function analyze(...args) {
  return JSON.parse(
    execFileSync(process.execPath, [script.pathname, ...args, "--json"], { encoding: "utf8" }),
  );
}

test("reports turns and token usage for every harness", () => {
  const root = mkdtempSync(join(tmpdir(), "eve-benchmark-analyze-"));
  try {
    writeRuns(root, runs);
    const records = analyze(root);
    assert.deepEqual(
      records.map(({ case: name, turns, toolCalls, usage }) => ({
        name,
        turns,
        toolCalls,
        input: usage?.input,
        output: usage?.output,
      })),
      [
        { name: "author-claude-code", turns: 1, toolCalls: 2, input: 10, output: 3 },
        { name: "author-codex", turns: 1, toolCalls: 2, input: 6, output: 3 },
        { name: "author-opencode", turns: 1, toolCalls: 2, input: 10, output: 3 },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports unreadable usage as null rather than zero", () => {
  const root = mkdtempSync(join(tmpdir(), "eve-benchmark-analyze-"));
  try {
    writeRuns(root, { codex: runs.codex.slice(0, 2) });
    const [record] = analyze(root);
    assert.equal(record.usage, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregates docs reads across harnesses and lists unread pages", () => {
  const root = mkdtempSync(join(tmpdir(), "eve-benchmark-analyze-"));
  try {
    writeRuns(root, runs);
    const usage = analyze(root, "--docs");

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

test("counts docs pages named relative to a cd into the docs", () => {
  const root = mkdtempSync(join(tmpdir(), "eve-benchmark-analyze-"));
  const bash = (command) => ({ type: "tool_use", name: "Bash", input: { command } });
  const codex = (command) => ({
    type: "item.started",
    item: { type: "command_execution", command: `bash -lc '${command}'` },
  });
  const opencode = (command) => ({
    type: "tool_use",
    part: { tool: "bash", state: { status: "completed", input: { command }, output: "" } },
  });
  try {
    writeRuns(root, {
      "claude-code": [
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 10, output_tokens: 3 },
            content: [
              bash(`cd ${docs} && cat channels/slack.mdx ${docs}/README.md > /tmp/slack.md`),
              // Claude Code's shell keeps its directory between calls.
              bash("cat ./tools/overview.mdx; ls memory/"),
              bash("cd /vercel/sandbox && cat AGENTS.md"),
              bash("cd node_modules/eve; cat docs/skills.mdx README.md"),
            ],
          },
        },
      ],
      codex: [codex(`cd ${docs} && cat channels/slack.mdx`), codex(`cd ${docs} && ls memory/`)],
      // OpenCode starts each call at the project root, so `AGENTS.md` is not a docs page.
      opencode: [opencode(`cd ${docs} && ls`), opencode("cat AGENTS.md")],
    });
    const records = analyze(root);
    assert.deepEqual(
      records.map(({ docsEntry, docsRead }) => ({ docsEntry, docsRead })),
      [
        {
          docsEntry: "channels/slack.mdx",
          docsRead: {
            "README.md": 1,
            "channels/slack.mdx": 1,
            "memory/*": 1,
            "skills.mdx": 1,
            "tools/overview.mdx": 1,
          },
        },
        { docsEntry: "channels/slack.mdx", docsRead: { "channels/slack.mdx": 1, "memory/*": 1 } },
        { docsEntry: null, docsRead: {} },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

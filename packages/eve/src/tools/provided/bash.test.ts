import { describe, expect, it } from "vitest";

import { bash, type BashToolOutput } from "./bash.js";

const finished: BashToolOutput = {
  exitCode: 1,
  status: "completed",
  stderr: "FAIL parser_test.go",
  stdout: "ok   compiler\n",
  truncated: false,
};

const RUNNING_NOTE = "The command is still running after 60 seconds as process group 42.";

describe("bash model output", () => {
  // `output` is `unknown` so a row can carry a value a wrapper's own `execute` returns.
  it.each<{ name: string; output: unknown; expected: unknown }>([
    {
      name: "a failed command's streams, then its exit code, as an error",
      output: finished,
      expected: {
        type: "error-text",
        value: "ok   compiler\n\n[stderr]\nFAIL parser_test.go\n[exit code: 1]",
      },
    },
    {
      name: "a successful command's output without an exit code",
      output: { exitCode: 0, status: "completed", stderr: "", stdout: "ok\n", truncated: false },
      expected: { type: "text", value: "ok\n" },
    },
    {
      name: "(no output) when a successful command printed nothing",
      output: { exitCode: 0, status: "completed", stderr: "", stdout: "", truncated: false },
      expected: { type: "text", value: "(no output)" },
    },
    {
      name: "stderr alone when stdout is empty",
      output: {
        exitCode: 127,
        status: "completed",
        stderr: "gofmt: not found\n",
        stdout: "",
        truncated: false,
      },
      expected: { type: "error-text", value: "[stderr]\ngofmt: not found\n[exit code: 127]" },
    },
    {
      name: "a running command's output so far, then how to check on it",
      output: {
        message: RUNNING_NOTE,
        outputDirectory: "/tmp/.eve/jobs/3f9a1c2e",
        pid: 42,
        status: "running",
        stderr: "go: downloading golang.org/x/mod\n",
        stdout: '{"suite": "go test"}\n',
        truncated: false,
      },
      expected: {
        type: "text",
        value: `{"suite": "go test"}\n\n[stderr]\ngo: downloading golang.org/x/mod\n${RUNNING_NOTE}`,
      },
    },
    {
      name: "JSON for a result a wrapper extended with its own fields",
      output: { ...finished, hint: "rerun with -v" },
      expected: { type: "json", value: { ...finished, hint: "rerun with -v" } },
    },
    {
      name: "JSON for a stream-shaped value without a status",
      output: { approved: false, stderr: "", stdout: "ok" },
      expected: { type: "json", value: { approved: false, stderr: "", stdout: "ok" } },
    },
    {
      name: "text for a string a wrapper returns",
      output: "Command blocked by policy.",
      expected: { type: "text", value: "Command blocked by policy." },
    },
  ])("shows $name", async ({ output, expected }) => {
    expect(await bash.toModelOutput!(output as BashToolOutput)).toEqual(expected);
  });
});

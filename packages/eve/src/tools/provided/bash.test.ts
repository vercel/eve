import { describe, expect, it } from "vitest";

import { bash, type BashToolOutput } from "./bash.js";

describe("bash model output", () => {
  // `output` is `unknown` so a row can carry a shape a wrapper's own `execute` returns.
  it.each<{ name: string; output: unknown; expected: unknown }>([
    {
      name: "a finished command's streams, then its exit code",
      output: {
        exitCode: 1,
        status: "completed",
        stderr: "FAIL parser_test.go",
        stdout: "ok   compiler\n",
        truncated: false,
      },
      expected: {
        type: "text",
        value: "ok   compiler\n\nstderr:\nFAIL parser_test.go\nexit code: 1",
      },
    },
    {
      name: "only the exit code when the command printed nothing",
      output: { exitCode: 0, status: "completed", stderr: "", stdout: "", truncated: false },
      expected: { type: "text", value: "exit code: 0" },
    },
    {
      name: "a running command's output so far, then how to check on it",
      output: {
        message: "The command is still running after 30 seconds as process group 42.",
        outputDirectory: "/tmp/.eve/jobs/3f9a1c2e",
        pid: 42,
        status: "running",
        stderr: "",
        stdout: '{"suite": "go test"}\n',
        truncated: false,
      },
      expected: {
        type: "text",
        value:
          '{"suite": "go test"}\nThe command is still running after 30 seconds as process group 42.',
      },
    },
    {
      name: "JSON for another shape a wrapper's execute returns",
      output: { approved: false, stderr: "", stdout: "ok" },
      expected: { type: "json", value: { approved: false, stderr: "", stdout: "ok" } },
    },
  ])("shows $name", async ({ output, expected }) => {
    expect(await bash.toModelOutput!(output as BashToolOutput)).toEqual(expected);
  });
});

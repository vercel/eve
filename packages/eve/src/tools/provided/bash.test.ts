import { afterEach, describe, expect, it, vi } from "vitest";

import { BASH_MAX_YIELD_SECONDS, BASH_YIELD_SECONDS } from "#execution/sandbox/bash.js";
import { toolModelOutputContext } from "#harness/tool-model-output.js";
import {
  isTaskPromotion,
  readTaskPromotionCancel,
  withTaskPromotionAllowed,
} from "#tools/task-handoff.js";
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
    expect(
      await bash.toModelOutput!(output as BashToolOutput, toolModelOutputContext("bash", "call_1")),
    ).toEqual(expected);
  });
});

function createSlowFakeSandbox() {
  const runCommands: string[] = [];
  const sandbox = {
    spawn: async () => ({
      kill: async () => {},
      pid: 4242,
      stderr: new ReadableStream({ start() {} }),
      stdout: new ReadableStream({ start() {} }),
      wait: () => new Promise<{ exitCode: number }>(() => {}),
    }),
    run: async ({ command }: { readonly command: string }) => {
      runCommands.push(command);
      const marker = /eve-bash:[a-f0-9]+/.exec(command)?.[0];
      if (marker !== undefined) {
        return { exitCode: 0, stderr: "", stdout: `${marker} 4242 8 0\nworking\n` };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  };
  return { runCommands, sandbox };
}

describe("bash timeout mode", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills commands on expiry when an explicit timeout <= 120s is passed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runCommands, sandbox } = createSlowFakeSandbox();
    const ctx = { abortSignal: new AbortController().signal, getSandbox: async () => sandbox };

    const pending = withTaskPromotionAllowed(true, () =>
      bash.execute!({ command: "sleep 300", timeout: BASH_MAX_YIELD_SECONDS }, ctx as never),
    );
    await vi.advanceTimersByTimeAsync(BASH_MAX_YIELD_SECONDS * 1000);
    const result = await pending;

    expect(result).toMatchObject({ exitCode: 124, status: "completed", stdout: "working\n" });
    expect(runCommands.some((cmd) => cmd.includes("kill -TERM -- -4242"))).toBe(true);
  });

  it.each([
    { timeout: undefined, waitSeconds: BASH_YIELD_SECONDS },
    { timeout: BASH_MAX_YIELD_SECONDS + 1, waitSeconds: BASH_MAX_YIELD_SECONDS },
  ])(
    "promotes still-running commands to a task when timeout=$timeout (and returns running outside a turn)",
    async ({ timeout, waitSeconds }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { runCommands, sandbox } = createSlowFakeSandbox();
      const ctx = { abortSignal: new AbortController().signal, getSandbox: async () => sandbox };
      const input = { command: "sleep 300", ...(timeout !== undefined && { timeout }) };

      const directPending = bash.execute!(input, ctx as never);
      await vi.advanceTimersByTimeAsync(waitSeconds * 1000);
      expect(await directPending).toMatchObject({ pid: 4242, status: "running" });

      const promotedPending = withTaskPromotionAllowed(true, () =>
        bash.execute!(input, ctx as never),
      );
      await vi.advanceTimersByTimeAsync(waitSeconds * 1000);
      const promoted = await promotedPending;
      expect(isTaskPromotion(promoted)).toBe(true);
      if (!isTaskPromotion(promoted)) return;
      expect(promoted.handoff).toMatchObject({ pid: 4242 });
      await readTaskPromotionCancel(promoted)?.();
      expect(runCommands.some((cmd) => cmd.includes("kill -TERM -- -4242"))).toBe(true);
    },
  );
});

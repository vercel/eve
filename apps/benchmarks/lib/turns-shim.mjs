// Runs in the eval sandbox in place of the harness CLI. agent-eval's runners send one
// prompt, so when an invocation carries a case's first prompt, this sends every later
// prompt as a follow-up in the same CLI session before returning. Any other invocation
// (login, version checks, judge calls) passes straight through. Zero-dependency: the
// sandbox only has node.

import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

/** Arguments that send `prompt` to the session started by `args`, which printed `output`. */
function followUpArgs(cli, args, promptIndex, prompt, output) {
  const before = args.slice(0, promptIndex);
  const after = args.slice(promptIndex + 1);
  switch (cli) {
    case "claude":
      return ["--continue", ...before, prompt, ...after];
    case "codex": {
      // `resume` is an `exec` subcommand, so the exec options before the prompt still apply.
      const thread = jsonEvents(output).find((event) => event.type === "thread.started");
      return [...before, "resume", thread?.thread_id ?? "--last", prompt, ...after];
    }
    case "opencode": {
      const session = jsonEvents(output).find((event) => typeof event.sessionID === "string");
      return session === undefined
        ? [...before, prompt, "--continue", ...after]
        : [...before, prompt, "--session", session.sessionID, ...after];
    }
    default:
      throw new Error(`No follow-up turns for ${JSON.stringify(cli)}.`);
  }
}

function jsonEvents(output) {
  return output.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return typeof event === "object" && event !== null ? [event] : [];
    } catch {
      return [];
    }
  });
}

function realBinary(cli, wrapper) {
  const self = realpathSync(wrapper);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, cli);
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) !== self) return candidate;
    } catch {
      // Not on this PATH entry.
    }
  }
  throw new Error(`Could not find the real ${cli} binary on PATH.`);
}

function main() {
  const [wrapper, ...args] = process.argv.slice(2);
  const cli = basename(wrapper);
  const binary = realBinary(cli, wrapper);
  const { prompts } = JSON.parse(readFileSync(new URL("./turns.json", import.meta.url), "utf8"));
  // agent-eval passes PROMPT.md untrimmed.
  const promptIndex = args.findIndex((arg) => arg.trim() === prompts[0].trim());
  if (promptIndex === -1) {
    const result = spawnSync(binary, args, { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }

  let firstOutput = "";
  for (const [turn, prompt] of prompts.entries()) {
    const turnArgs = turn === 0 ? args : followUpArgs(cli, args, promptIndex, prompt, firstOutput);
    const result = spawnSync(binary, turnArgs, {
      stdio: ["inherit", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) throw result.error;
    if (turn === 0) firstOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

main();

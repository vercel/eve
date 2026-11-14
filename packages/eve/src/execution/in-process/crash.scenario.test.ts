import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { crashShape, RETRIED_TOOL_STEP_SHAPE } from "#internal/testing/in-process-crash/agent.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

// A process that runs a session in process dies by SIGKILL mid-turn, and a second process
// continues the turn from what Workflow's local World kept. The step that was running runs again, as
// Workflow retries a step whose process died before its completion was recorded, and the stream
// is the one `crash-parity.integration.test.ts` checks Workflow writes. Both processes are real
// (`#internal/testing/in-process-crash/child.ts`).

vi.setConfig({ testTimeout: 120_000 });

const eve = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pnpmStore = join(eve, "../../node_modules/.pnpm");
const tsx = join(
  pnpmStore,
  readdirSync(pnpmStore).find((name) => name.startsWith("tsx@"))!,
  "node_modules/tsx/dist/cli.mjs",
);

function child(dir: string, command: "start" | "resume", crash: Crash) {
  return spawnSync(
    process.execPath,
    [
      tsx,
      "--conditions=eve-source",
      "--tsconfig",
      join(eve, "tsconfig.json"),
      join(eve, "src/internal/testing/in-process-crash/child.ts"),
      dir,
      command,
      crash,
    ],
    { encoding: "utf8", timeout: 90_000 },
  );
}

type Crash = "after-tool" | "mid-tool" | "awaiting-approval";

const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

/** Runs `crash` in one process and continues it in the next, and what the two left behind. */
function crashAndResume(crash: Crash) {
  const dir = mkdtempSync(join(tmpdir(), `eve-crash-${crash}-`));
  const first = child(dir, "start", crash);
  // tsx runs the script in a process of its own and exits as it did: 128 + SIGKILL.
  expect(first.status, first.stderr).toBe(137);
  const second = child(dir, "resume", crash);
  expect(second.status, second.stderr).toBe(0);
  const streamed: Pick<SessionStreamEvent, "data" | "type">[] = lines(
    join(dir, "resume.events.jsonl"),
  ).map((line) => JSON.parse(line));
  return { prompts: lines(join(dir, "prompts.log")), ran: lines(join(dir, "ran.log")), streamed };
}

describe("an in-process turn a kill -9 cut off", () => {
  it("goes on in the next process after the tool ran, as a Workflow retry does", () => {
    const { prompts, ran, streamed } = crashAndResume("after-tool");
    // `deploy` ran once, in the first process; the model call after the crash read that.
    expect(ran).toEqual(["deploy"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("its result was lost when the step running it was interrupted");
    // What the second process streamed is the whole session, as the store kept it.
    expect(crashShape(streamed)).toEqual(RETRIED_TOOL_STEP_SHAPE);
  });

  it("goes on in the next process while the tool ran, and the model reads it may have run", () => {
    const { prompts, ran, streamed } = crashAndResume("mid-tool");
    // `deploy` started once, in the first process, and isn't run again.
    expect(ran).toEqual(["deploy"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      "deploy {}: The step running this call was interrupted. The call may or may not have taken effect.",
    );
    expect(crashShape(streamed)).toContain("call.settled:abandoned");
    expect(crashShape(streamed).filter((type) => type.startsWith("turn.settled"))).toEqual([
      "turn.settled:completed",
    ]);
  });

  it("restores a turn waiting on an approval in the next process, which runs the tool once approved", () => {
    const { prompts, ran, streamed } = crashAndResume("awaiting-approval");
    // Nothing ran before the approval; once approved in the second process, `deploy` runs once.
    expect(ran).toEqual(["deploy"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("interrupted");
    const types = crashShape(streamed);
    expect(types.filter((type) => type.startsWith("turn."))).toEqual([
      "turn.started",
      "turn.paused",
      "turn.settled:completed",
    ]);
    expect(types).toContain("call.settled:completed");
  });
});

import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof that a local background task can raise HITL after its
 * dispatching parent turn has completed. The real task workflow must wake the
 * idle TUI, each answer must route directly to the blocked child, and the task
 * must eventually wake the parent with its terminal notification.
 */

process.env.EVE_TUI_UNICODE = "1";

const GATES = ["first_gate", "second_gate", "third_gate"] as const;

run(
  {
    app: "fixture-tasks",
    kind: "local-build",
    startEnv: { ...process.env, EVE_E2E_MODEL: "mock" },
  },
  async (target) => {
    const client = new Client({ host: target.baseUrl });
    const screen = new MockScreen({ columns: 120, rows: 50 });
    const input = new MockUserInput();
    const runner = new EveTUIRunner({
      client,
      screen,
      userInput: input,
      name: "Background task HITL smoke",
    });

    const runPromise = runner.run().catch((error: unknown) => {
      if (error instanceof Error && error.message === "Interrupted") return;
      throw error;
    });

    await screen.waitForIdlePrompt(5_000);
    input.type("TASK-HITL-ROUTING");
    input.enter();

    await screen.waitForText("TASK-HITL-STARTED", 60_000);
    console.log(theme.muted("[tui-background-task-hitl] background task started"));

    for (const gate of GATES) {
      await waitForCondition(() => approvalPromptVisible(screen.snapshot(), gate), {
        timeoutMs: 60_000,
        label: `approval prompt for ${gate}`,
        onTimeout: () => screen.snapshot(),
      });
      await sleep(500);
      input.emit("data", Buffer.from("y"));
      console.log(theme.muted(`[tui-background-task-hitl] approved ${gate}`));
    }

    await screen.waitForText("TASK-NOTIFICATION-ACK", 60_000);
    await screen.waitForIdlePrompt(30_000);

    const finalSnapshot = screen.snapshot();
    if (finalSnapshot.includes("Error")) {
      throw new Error(`Final screen contains an Error section:\n${finalSnapshot}`);
    }

    console.log(theme.muted("[tui-background-task-hitl] task completed and parent returned idle"));
    input.ctrlC();
    input.ctrlC();
    await runPromise;
  },
);

function approvalPromptVisible(snapshot: string, toolName: string): boolean {
  return (
    snapshot.includes(`Approve ${toolName}?`) ||
    snapshot.includes(`Approve ${toolName.replaceAll("_", " ")}?`)
  );
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs: number; label: string; intervalMs?: number; onTimeout?: () => string },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  const extra = options.onTimeout?.() ?? "";
  throw new Error(`Timed out waiting for: ${options.label}${extra ? `\n\n${extra}` : ""}`);
}

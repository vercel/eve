import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * Covers the freeform-via-arrow-nav UX. The model raises an
 * `ask_question` with `allowFreeform: true` and a small set of
 * predefined options. The TUI surfaces a navigable "Type your own
 * answer" row below the last option. Pressing Enter on that row
 * switches to text mode, and the typed reply is sent as `text` (not
 * `optionId`).
 */

const FREEFORM_ANSWER = "indigo-sandbox-eu";
process.env.EVE_TUI_UNICODE = "1";

run({ app: "agent-tui-client", kind: "local-build" }, async (target) => {
  const client = new Client({ host: target.baseUrl });
  const session = client.session();
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session,
    screen,
    userInput: input,
    name: "TUI smoke",
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  await screen.waitForText("❯", 5_000);

  const promptLines = [
    "Use the ask_question tool exactly once to ask me to choose an environment.",
    "Set prompt to: 'Which environment?'",
    "Set allowFreeform to true.",
    "Provide exactly three options:",
    `- id "prod", label "Production"`,
    `- id "staging", label "Staging"`,
    `- id "preview", label "Preview"`,
    "Wait for my response. Then repeat back exactly what I said.",
  ];
  input.type(promptLines.join(" · "));
  input.enter();

  await screen.waitForText("▷ Production", 60_000);
  console.log(theme.muted("[tui-freeform] select UI live, highlight on Production"));

  await sleep(500);

  // Navigate past every predefined option to the freeform row.
  input.emit("data", Buffer.from("\x1B[B")); // → Staging
  input.emit("data", Buffer.from("\x1B[B")); // → Preview
  input.emit("data", Buffer.from("\x1B[B")); // → Type your own answer
  await screen.waitForText("▷ Type your own answer", 2_000);
  console.log(theme.muted("[tui-freeform] highlight moved to freeform row"));

  // Enter on the freeform row activates text mode. Text mode clears the
  // status hints, so the proof it is active is the typed text rendering
  // in the input row before we submit it.
  input.enter();
  input.type(FREEFORM_ANSWER);
  await screen.waitForText(FREEFORM_ANSWER, 2_000);
  console.log(theme.muted("[tui-freeform] text mode active, answer typed"));

  input.enter();

  await screen.waitForText(`✓ ${FREEFORM_ANSWER}`, 5_000);
  console.log(theme.muted("[tui-freeform] freeform answer recorded in body"));

  // The follow-up assistant turn renders a `▲`-prefixed section below
  // the answered question that echoes the freeform text.
  await waitForCondition(
    () => assistantReplyAfter(screen.snapshot(), `✓ ${FREEFORM_ANSWER}`, FREEFORM_ANSWER),
    {
      timeoutMs: 60_000,
      label: "follow-up assistant section echoing the freeform answer",
    },
  );
  console.log(theme.muted("[tui-freeform] follow-up assistant turn rendered"));

  const finalSnapshot = screen.snapshot();
  if (finalSnapshot.includes("Error")) {
    throw new Error(`Final screen contains an Error section:\n${finalSnapshot}`);
  }
  if (!finalSnapshot.includes(FREEFORM_ANSWER)) {
    throw new Error(
      `Expected the assistant follow-up to echo "${FREEFORM_ANSWER}", but it did not appear in:\n${finalSnapshot}`,
    );
  }

  // The turn is complete; wait until the runner is back at the prompt so
  // Ctrl+C exits the session. A Ctrl+C mid-stream now only interrupts the
  // turn and returns to the prompt (Claude Code's two-step exit).
  await screen.waitForText("❯", 30_000);
  input.ctrlC();
  await runPromise;
});

/**
 * True when an assistant section (a `▲`-prefixed line and its wrapped
 * continuations) below `afterMarker` contains `needle`. Used to assert a
 * follow-up reply without matching transcript content above the marker.
 */
function assistantReplyAfter(snapshot: string, afterMarker: string, needle: string): boolean {
  const markerIndex = snapshot.indexOf(afterMarker);
  if (markerIndex === -1) return false;
  const region = snapshot.slice(markerIndex + afterMarker.length);
  const brandIndex = region.indexOf("▲ ");
  if (brandIndex === -1) return false;
  return region.slice(brandIndex).toLowerCase().includes(needle.toLowerCase());
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs: number; label: string; intervalMs?: number },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${options.label}`);
}

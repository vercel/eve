import { Client } from "#client/client.js";
import { EveTUIRunner } from "#cli/dev/tui/runner.js";
import { TerminalRenderer } from "#cli/dev/tui/terminal-renderer.js";
import { MockScreen, MockUserInput } from "#cli/dev/tui/test/mock-terminal.js";
import type {
  ClientDriver,
  RenderedOption,
} from "#internal/testing/channel-conformance/harness.js";

/** Each drawer's footer: a question's, then a tool approval's. */
const DRAWER_FOOTERS = [
  "↑/↓ move · enter to select · esc to dismiss",
  "y yes · n no · Ctrl-C cancel",
] as const;
const FREEFORM_ROW = "Type your own answer…";

/**
 * Drives the real `eve dev` TUI on a mock terminal. It reads only the screen
 * and acts only through keys, as a person at the terminal would.
 */
export function tuiDriver(): ClientDriver {
  return {
    name: "tui",
    capabilities: ["buttons", "text-replies"],
    async open(host, wait) {
      // Wide enough that no reply wraps, so each one stays on one screen row.
      const screen = new MockScreen({ columns: 1000, rows: 60 });
      const keyboard = new MockUserInput();
      const renderer = new TerminalRenderer({
        captureForeignOutput: false,
        input: keyboard,
        output: screen,
        unicode: true,
      });
      const run = new EveTUIRunner({ client: new Client({ host }), name: "tui", renderer }).run();
      const describe = () => `Screen:\n${screen.snapshot()}`;
      try {
        // Surfaces a runner that fails during startup instead of waiting out the timeout.
        await Promise.race([
          wait("the composer", () => (composerOpen(screen) ? true : undefined), describe),
          run.then(() => {
            throw new Error(`The TUI exited before its composer opened. ${describe()}`);
          }),
        ]);
      } catch (error) {
        // The caller only gets `close()` once `open()` resolves, so stop the runner here.
        renderer.requestInterrupt();
        await run.catch(() => {});
        throw error;
      }

      return {
        async say(text) {
          // A question drawer holds the keyboard until Esc hands it back to the composer.
          if (drawerOpen(screen)) keyboard.send("\x1b");
          await wait("the composer", () => (composerOpen(screen) ? true : undefined), describe);
          keyboard.type(text);
          keyboard.enter();
        },
        async waitForQuestion(prompt) {
          await wait(`the question "${prompt}"`, () => focusedRow(screen, prompt), describe);
          return readOptions(screen, keyboard, prompt);
        },
        async press(option) {
          // `waitForQuestion` leaves the cursor on the first option.
          for (let row = 0; row < (option.handle as number); row += 1) keyboard.down();
          keyboard.enter();
        },
        replies: () => readReplies(screen.snapshot()),
        describe,
        async close() {
          renderer.requestInterrupt();
          await run;
        },
      };
    },
  };
}

/** Each assistant reply: a `▲ ` row and the indented rows its text continues on. */
function readReplies(snapshot: string): string[] {
  const replies: string[] = [];
  let reply: string[] | undefined;
  for (const line of snapshot.split("\n")) {
    if (line.startsWith("▲ ")) {
      reply = [line.slice(2)];
      replies.push("");
    } else if (reply !== undefined && line.startsWith("  ")) {
      reply.push(line.slice(2));
    } else {
      reply = undefined;
    }
    if (reply !== undefined) replies[replies.length - 1] = reply.join("\n");
  }
  return replies;
}

function drawerOpen(screen: MockScreen): boolean {
  const snapshot = screen.snapshot();
  return DRAWER_FOOTERS.some((footer) => snapshot.includes(footer));
}

function composerOpen(screen: MockScreen): boolean {
  return !drawerOpen(screen) && /^❯/mu.test(screen.snapshot());
}

/**
 * A drawer draws only the row under its cursor at full weight; every other
 * option, each description, and the freeform row are dim. A person reads the
 * options by moving the cursor through them, and so does the driver, until the
 * cursor wraps to the first option or stops at the last. The TUI repaints
 * synchronously on each key, so the screen is current right after one.
 */
function readOptions(screen: MockScreen, keyboard: MockUserInput, prompt: string) {
  const options: RenderedOption[] = [];
  const first = focusedRow(screen, prompt);
  let row = first;
  while (row !== undefined) {
    if (!row.freeform) options.push({ handle: options.length, label: row.text });
    keyboard.down();
    const next = focusedRow(screen, prompt);
    if (next === undefined || next.line === row.line || next.line === first?.line) break;
    row = next;
  }
  // Leave the cursor on the first option, as a fresh drawer has it.
  for (let moves = 0; moves < 10 && focusedRow(screen, prompt)?.line !== first?.line; moves++) {
    keyboard.up();
  }
  return options;
}

/** The full-weight row between `prompt` and its drawer's footer: the one under the cursor. */
function focusedRow(
  screen: MockScreen,
  prompt: string,
): { readonly freeform: boolean; readonly line: number; readonly text: string } | undefined {
  const lines = screen.snapshot().split("\n");
  const bright = screen.snapshot({ hideDim: true }).split("\n");
  const footer = lines.findLastIndex((line) =>
    DRAWER_FOOTERS.some((candidate) => line.includes(candidate)),
  );
  const start = bright.slice(0, footer).findLastIndex((line) => line.trim() === prompt);
  if (footer === -1 || start === -1) return undefined;
  for (let line = start + 1; line < footer; line += 1) {
    const text = bright[line]!.trim();
    if (text.length === 0) continue;
    return { freeform: lines[line]!.includes(FREEFORM_ROW), line, text };
  }
  return undefined;
}

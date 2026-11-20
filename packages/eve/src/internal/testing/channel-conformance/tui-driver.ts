import { Client } from "#client/client.js";
import { EveTUIRunner } from "#cli/dev/tui/runner.js";
import { TerminalRenderer } from "#cli/dev/tui/terminal-renderer.js";
import { MockScreen, MockUserInput } from "#cli/dev/tui/test/mock-terminal.js";
import type {
  ClientDriver,
  RenderedOption,
} from "#internal/testing/channel-conformance/harness.js";

const FREEFORM_FOOTER = "Enter submit · Esc dismiss";
const DRAWER_FOOTERS = [
  "↑/↓ move · enter to select · esc to dismiss",
  "y yes · n no · Ctrl-C cancel",
  FREEFORM_FOOTER,
] as const;
const MAX_DRAWERS = 5;
const FREEFORM_ROW = "Type your own answer…";

export function tuiDriver(): ClientDriver {
  return {
    name: "tui",
    capabilities: ["buttons", "text-replies"],
    surface: "private",
    async open(host, wait) {
      const screen = new MockScreen({ columns: 1000, rows: 60 });
      const keyboard = new MockUserInput();
      const renderer = new TerminalRenderer({
        captureForeignOutput: false,
        input: keyboard,
        output: screen,
        unicode: true,
      });
      const run = new EveTUIRunner({
        client: new Client({ baseUrl: host }),
        name: "tui",
        renderer,
      }).run();
      const describe = () => `Screen:\n${screen.snapshot()}`;
      try {
        await Promise.race([
          wait("the composer", () => (composerOpen(screen) ? true : undefined), describe),
          run.then(() => {
            throw new Error(`The TUI exited before its composer opened. ${describe()}`);
          }),
        ]);
      } catch (error) {
        renderer.requestInterrupt();
        await run.catch(() => {});
        throw error;
      }

      return {
        async say(text) {
          for (let drawers = 0; drawers < MAX_DRAWERS && drawerOpen(screen); drawers += 1) {
            const before = screen.snapshot();
            keyboard.send("\x1b");
            await wait(
              "the drawer to close",
              () => (screen.snapshot() !== before ? true : undefined),
              describe,
            );
          }
          await wait("the composer", () => (composerOpen(screen) ? true : undefined), describe);
          keyboard.send(text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text);
          keyboard.enter();
        },
        async waitForQuestion(prompts) {
          const prompt = await wait(
            `one of the questions ${JSON.stringify(prompts)}`,
            () => prompts.find((candidate) => focusedRow(screen, candidate) !== undefined),
            describe,
          );
          if (screen.snapshot().includes(FREEFORM_FOOTER)) return { options: [], prompt };
          return { options: readOptions(screen, keyboard, prompt), prompt };
        },
        async press(option) {
          for (let row = 0; row < (option.handle as number); row += 1) keyboard.down();
          keyboard.enter();
        },
        replies: () => readReplies(screen.snapshot()),
        shownPrompt: (prompt) => ({
          id: prompt,
          options:
            focusedRow(screen, prompt) === undefined ? [] : readOptions(screen, keyboard, prompt),
          text: screen.snapshot(),
        }),
        shown: () => [{ onlyPerson: true, options: [], text: screen.snapshot() }],
        describe,
        async close() {
          renderer.requestInterrupt();
          await run;
        },
      };
    },
  };
}

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
  for (let moves = 0; moves < 10 && focusedRow(screen, prompt)?.line !== first?.line; moves++) {
    keyboard.up();
  }
  return options;
}

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

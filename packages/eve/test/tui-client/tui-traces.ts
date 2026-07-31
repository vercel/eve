import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "eve/client";
import {
  createPromptCommandHandler,
  EveTUIRunner,
  MockScreen,
  MockUserInput,
  promptCommandsFor,
} from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof of the `/traces` alt-screen conversation viewer.
 *
 *   1. `/traces` opens on a seeded spool: system, user, assistant, and tool
 *      cards render; the long system prompt starts capped behind its card.
 *   2. `→`/`←` expand and collapse the selected card; a mouse click toggles
 *      it too.
 *   3. Enter opens the details drawer: metadata only — payload attributes
 *      stay on the cards and never leak into the drawer.
 *   4. `[` cycles to the older trace; Escape returns to the prompt with the
 *      transcript restored.
 *   5. An empty spool renders the empty state instead of an error.
 *
 * Needs no agent server and no model credentials.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49214";
process.env.EVE_TUI_UNICODE = "1";

const TRACE_ONE = "1".repeat(32);
const TRACE_TWO = "2".repeat(32);

const SYSTEM_PROMPT_TAIL = "END-OF-SYSTEM-PROMPT-MARKER";
// Long enough to wrap past the collapsed card's preview cap, so the system
// card has content hidden behind the expand affordance.
const SYSTEM_PROMPT = `${"smoke system prompt guidance. ".repeat(24)}${SYSTEM_PROMPT_TAIL}`;

void (async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-tui-traces-"));
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 110, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session: client.session(),
    client,
    screen,
    userInput: input,
    name: "TUI traces",
    appRoot,
    availablePromptCommands: promptCommandsFor("local"),
    promptCommandHandler: createPromptCommandHandler({
      target: { kind: "local", serverUrl: UNREACHABLE_HOST, workspaceRoot: appRoot },
    }),
  });
  const runPromise = runner.run();

  try {
    const sessionWindow = "9".repeat(16);
    const turn = "a".repeat(16);
    const step = "b".repeat(16);
    const model = "c".repeat(16);
    const action = "e".repeat(16);
    const toolCall = "f".repeat(16);
    // A real capture roots turns under the session's window span, so the
    // fixture does too — turn discovery must not depend on root position.
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: sessionWindow,
      name: "agent.session",
      start: 900,
      end: 900,
      attributes: {
        "agent.session.id": "session-smoke",
        "agent.name": "smoke-agent",
        "agent.session.window": 0,
      },
    });
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: turn,
      name: "agent.turn",
      start: 1_000,
      end: 1_000,
      parentSpanId: sessionWindow,
      attributes: { "agent.session.id": "session-smoke", "agent.name": "smoke-agent" },
    });
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: step,
      name: "agent.step",
      start: 1_500,
      end: 9_000,
      parentSpanId: turn,
      attributes: { "agent.step.index": 0 },
    });
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: model,
      name: "ai.streamText.doStream",
      start: 2_000,
      end: 5_000,
      parentSpanId: step,
      attributes: {
        "gen_ai.request.model": "smoke-model-v1",
        "ai.prompt.system": SYSTEM_PROMPT,
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: "smoke prompt" }]),
        "ai.response.text": "smoke reply",
      },
    });
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: action,
      name: "agent.action",
      start: 6_000,
      end: 6_300,
      parentSpanId: step,
      attributes: { "agent.action.kind": "tool", "agent.action.name": "get_weather" },
    });
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: toolCall,
      name: "ai.toolCall",
      start: 6_000,
      end: 6_300,
      parentSpanId: action,
      attributes: {
        "gen_ai.tool.call.arguments": '{"city":"San Francisco"}',
        "gen_ai.tool.call.result": '{"temperature":72}',
        "gen_ai.tool.name": "get_weather",
      },
    });
    // A subagent child turn recorded into the same trace, carrying its
    // dispatch lineage (#1433 attributes).
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: "8".repeat(16),
      name: "agent.turn",
      start: 7_000,
      end: 7_000,
      parentSpanId: sessionWindow,
      attributes: {
        "agent.session.id": "child-session",
        "agent.parent.session.id": "session-smoke",
        "agent.parent.turn.id": "turn_0",
        "agent.parent.call_id": "call-1",
        "agent.subagent.name": "echo",
      },
    });
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: "7".repeat(16),
      name: "agent.step",
      start: 7_100,
      end: 8_000,
      parentSpanId: "8".repeat(16),
      attributes: { "agent.step.index": 0 },
    });
    await writeSegment(appRoot, TRACE_ONE, {
      spanId: "6".repeat(16),
      name: "ai.streamText.doStream",
      start: 7_200,
      end: 7_900,
      parentSpanId: "7".repeat(16),
      attributes: {
        "gen_ai.request.model": "smoke-model-v1",
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: "delegated task" }]),
        "ai.response.text": "delegated reply",
      },
    });
    await writeSegment(appRoot, TRACE_TWO, {
      spanId: "d".repeat(16),
      name: "agent.turn",
      start: 500,
      end: 900,
      attributes: { "agent.session.id": "older-session" },
    });
    // The viewer lists traces by segments-dir mtime (last span activity);
    // same-millisecond writes would race, so pin the ordering explicitly.
    const now = new Date();
    await utimes(join(appRoot, ".eve", "traces", "v1", TRACE_ONE, "segments"), now, now);
    const older = new Date(now.getTime() - 60_000);
    await utimes(join(appRoot, ".eve", "traces", "v1", TRACE_TWO, "segments"), older, older);

    await screen.waitForIdlePrompt(5_000);
    input.type("/traces");
    input.enter();

    // The viewer opens in the conversation view: message cards with tool
    // calls nested inside the assistant card, no chat prompt leaking.
    await screen.waitForText("smoke prompt", 5_000);
    await screen.waitForText("smoke reply", 5_000);
    await screen.waitForText("get_weather", 5_000);
    if (screen.snapshot().includes("›")) {
      throw new Error(`The chat prompt leaked into the viewer frame:\n${screen.snapshot()}`);
    }
    console.log(theme.muted("[tui-traces] /traces opened on the conversation cards"));

    // The long system prompt starts capped behind the collapsed card.
    await screen.waitForText("Click to expand", 5_000);
    if (screen.snapshot().includes(SYSTEM_PROMPT_TAIL)) {
      throw new Error(`The system card did not cap its preview:\n${screen.snapshot()}`);
    }

    // → expands the selected (system) card; ← collapses it again.
    input.right();
    await screen.waitForText(SYSTEM_PROMPT_TAIL, 5_000);
    await screen.waitForText("Click to collapse", 5_000);
    input.left();
    await screen.waitForText("Click to expand", 5_000);
    if (screen.snapshot().includes(SYSTEM_PROMPT_TAIL)) {
      throw new Error(`The system card did not collapse:\n${screen.snapshot()}`);
    }
    console.log(theme.muted("[tui-traces] arrow keys expand and collapse cards"));

    // A mouse click toggles a card open too: an SGR press+release at row 3
    // lands inside the first card (one header row, 1-based coordinates).
    // The click acts on release so drag selections never toggle cards.
    input.send("\x1b[<0;10;3M");
    input.send("\x1b[<0;10;3m");
    await screen.waitForText(SYSTEM_PROMPT_TAIL, 5_000);
    console.log(theme.muted("[tui-traces] mouse click expands a card"));
    input.left();
    await screen.waitForText("Click to expand", 5_000);

    // Dragging (press, SGR button-32 motion, release) selects text and
    // copies it, confirmed by the header toast.
    input.send("\x1b[<0;3;3M");
    input.send("\x1b[<32;30;3M");
    input.send("\x1b[<0;30;3m");
    await screen.waitForText("Copied to clipboard", 5_000);
    console.log(theme.muted("[tui-traces] drag selection copies to the clipboard"));

    // The details drawer stays metadata-only: the tool card carries the call
    // payload inline ("city" in its Input section), while the drawer lists
    // facts and metadata attributes — never the content keys.
    input.down();
    input.down();
    input.down();
    input.enter();
    await screen.waitForText("status", 5_000);
    await screen.waitForText("duration", 5_000);
    await screen.waitForText("gen_ai.tool.name", 5_000);
    if (!screen.snapshot().includes('"city"')) {
      throw new Error(`The tool card lost its inline payload:\n${screen.snapshot()}`);
    }
    if (screen.snapshot().includes("gen_ai.tool.call.arguments")) {
      throw new Error(
        `The drawer leaked a payload attribute in conversation mode:\n${screen.snapshot()}`,
      );
    }
    console.log(theme.muted("[tui-traces] details drawer shows metadata only"));

    // Escape closes the drawer first: an ESC immediately followed by another
    // key merges into an unfinished CSI in the input tokenizer and wedges
    // every key after it (the lone-ESC flush never fires).
    input.send("\x1b");
    await waitForAbsence(screen, "gen_ai.tool.name", 5_000);

    // The subagent child turn renders below the fold; End jumps to its cards,
    // which carry the dispatch lineage badge.
    input.send("\x1b[F");
    await screen.waitForText("subagent:echo", 5_000);
    await screen.waitForText("delegated reply", 5_000);
    console.log(theme.muted("[tui-traces] subagent turn is badged with its lineage"));
    input.send("\x1b[H");
    await screen.waitForText("Click to expand", 5_000);

    // `[` cycles to the older trace — a turn with no model spans, so it
    // renders the no-conversation placeholder.
    input.type("[");
    await screen.waitForText("older-se", 5_000);
    await screen.waitForText("No conversation content", 5_000);
    if (!screen.snapshot().includes("[2/2]")) {
      throw new Error(`Trace cycling did not reach the older trace:\n${screen.snapshot()}`);
    }
    console.log(theme.muted("[tui-traces] [ cycled to the older trace"));

    // The trace switch reset the drawer, so one Escape closes the viewer.
    input.send("\x1b");
    await screen.waitForIdlePrompt(5_000);
    if (screen.snapshot().includes("Click to expand")) {
      throw new Error(`The viewer did not restore the transcript:\n${screen.snapshot()}`);
    }
    console.log(theme.muted("[tui-traces] escape closed the viewer back to the prompt"));

    // Empty spool → the live empty state, not an error.
    const emptyRoot = await mkdtemp(join(tmpdir(), "eve-tui-traces-empty-"));
    try {
      const emptyRunner = bootRunner(emptyRoot);
      try {
        await emptyRunner.screen.waitForIdlePrompt(5_000);
        emptyRunner.input.type("/traces");
        emptyRunner.input.enter();
        await emptyRunner.screen.waitForText("No local traces yet.", 5_000);
        console.log(theme.muted("[tui-traces] empty spool rendered the empty state"));
        emptyRunner.input.type("q");
        await emptyRunner.screen.waitForIdlePrompt(5_000);
        emptyRunner.input.type("/exit");
        emptyRunner.input.enter();
        await withTimeout(emptyRunner.runPromise, 5_000, "empty /exit did not terminate");
      } finally {
        emptyRunner.input.ctrlC();
        await emptyRunner.runPromise.catch(() => {});
      }
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }

    input.type("/exit");
    input.enter();
    await withTimeout(runPromise, 5_000, "/exit did not terminate the runner");
  } catch (error) {
    // Failures can leave the alt-screen viewer open: close it (q), wait for
    // the prompt, then interrupt. A bare Ctrl+C would land in the viewer.
    input.type("q");
    await screen.waitForIdlePrompt(2_000).catch(() => {});
    input.ctrlC();
    input.ctrlC();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
})().catch((error: unknown) => {
  console.error(theme.danger("\n[tui] tui-traces smoke test failed:"), error);
  process.exitCode = 1;
});

function bootRunner(appRoot: string) {
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 110, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session: client.session(),
    client,
    screen,
    userInput: input,
    name: "TUI traces empty",
    appRoot,
    availablePromptCommands: promptCommandsFor("local"),
    promptCommandHandler: createPromptCommandHandler({
      target: { kind: "local", serverUrl: UNREACHABLE_HOST, workspaceRoot: appRoot },
    }),
  });
  return { screen, input, runPromise: runner.run() };
}

interface SegmentInput {
  readonly spanId: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly parentSpanId?: string;
  readonly attributes?: Record<string, string | number>;
}

async function writeSegment(appRoot: string, traceId: string, value: SegmentInput): Promise<void> {
  const directory = join(appRoot, ".eve", "traces", "v1", traceId, "segments");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${value.spanId}.otlp.json`),
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: "eve.agent" },
              spans: [
                {
                  attributes: Object.entries(value.attributes ?? {}).map(([key, attribute]) => ({
                    key,
                    value:
                      typeof attribute === "number"
                        ? { intValue: attribute }
                        : { stringValue: attribute },
                  })),
                  endTimeUnixNano: String(value.end * 1_000_000),
                  name: value.name,
                  parentSpanId: value.parentSpanId,
                  spanId: value.spanId,
                  startTimeUnixNano: String(value.start * 1_000_000),
                  status: { code: 0 },
                  traceId,
                },
              ],
            },
          ],
        },
      ],
    }),
  );
}

async function waitForAbsence(screen: MockScreen, text: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!screen.snapshot().includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Text did not leave the screen: ${text}\n\nScreen:\n${screen.snapshot()}`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

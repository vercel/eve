import { describe, expect, it, vi } from "vitest";

import type { AgentInfoResult } from "#client/index.js";
import type { LogRecord } from "#internal/logging.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";
import type { DevDiagnostics } from "../diagnostics.js";
import { searchActionValue } from "#setup/cli/select-state.js";
import {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  STRUCTURAL_RELOAD_LOG_LINE,
  formatChangeDetectedLogLine,
} from "#internal/nitro/host/dev-watcher-log.js";

import { initialConversationState, reduceConversation } from "#client/conversation-reducer.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createTurnStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import {
  tuiSessionReducer,
  type AgentTUIConversationView,
  type TuiSessionData,
} from "./conversation-view.js";
import type { AgentTUISessionOptions } from "./runner.js";
import { PROMPT_COMMANDS, promptCommandsFor } from "./prompt-commands.js";
import { TerminalRenderer } from "./terminal-renderer.js";
import { MockScreen, MockUserInput } from "./test/mock-terminal.js";

/** A session view over the conversation these events produce. */
function conversationOf(
  events: readonly EveAgentReducerEvent[],
  options: { working?: boolean; data?: Partial<TuiSessionData> } = {},
): AgentTUIConversationView {
  return {
    conversation: events.reduce(reduceConversation, initialConversationState()),
    working: options.working ?? false,
    data: { ...tuiSessionReducer.initial(), ...options.data },
    failures: [],
  };
}

/** The composer's next submitted text, as the runner reads it. */
async function readPrompt(
  renderer: TerminalRenderer,
  options?: AgentTUISessionOptions,
): Promise<string | undefined> {
  const input = await renderer.readInput(options);
  return input?.type === "submit" ? input.text : undefined;
}

function agentInfoWithDynamicModel(): AgentInfoResult {
  const info = createTestAgentInfoResult({ name: "Weather Agent" });
  return {
    ...info,
    agent: {
      ...info.agent,
      model: {
        routing: {
          kind: "dynamic",
          resolver: {
            eventNames: ["step.started"],
            slug: "model",
            logicalPath: "agent.ts",
            owner: { kind: "application" },
            sourceId: "agent-model",
            sourceKind: "module",
          },
        },
      },
    },
  };
}

function makeRenderer(columns = 80, rows = 30) {
  const screen = new MockScreen({ columns, rows });
  const input = new MockUserInput();
  const renderer = new TerminalRenderer({
    input,
    output: screen,
    captureForeignOutput: false,
    unicode: true,
  });
  return { screen, input, renderer };
}

function stubDiagnostics() {
  const append = vi.fn();
  const recordPrompt = vi.fn();
  const recordStepUsage = vi.fn();
  const recordToolCall = vi.fn();
  const recordSubagentDispatch = vi.fn();
  const reportStats = vi.fn();
  let subscriber: ((record: LogRecord) => void) | undefined;
  const diagnostics: DevDiagnostics = {
    displayPath: ".eve/logs/dev.log",
    append,
    recordPrompt,
    recordStepUsage,
    recordToolCall,
    recordSubagentDispatch,
    reportStats,
    subscribeLogRecords: (onRecord) => {
      subscriber = onRecord;
    },
    unsubscribeLogRecords: () => {
      subscriber = undefined;
    },
    close: async () => {},
  };
  return {
    diagnostics,
    append,
    recordPrompt,
    recordStepUsage,
    recordToolCall,
    recordSubagentDispatch,
    reportStats,
    emitLogRecord: (record: LogRecord) => subscriber?.(record),
    get subscribed() {
      return subscriber !== undefined;
    },
  };
}

type StaticAgentInfoModel = Extract<AgentInfoResult["agent"]["model"], { readonly id: string }>;

function agentInfoWithModel(
  modelId: string,
  endpoint?: StaticAgentInfoModel["endpoint"],
  extras?: Partial<StaticAgentInfoModel>,
): AgentInfoResult {
  const info = createTestAgentInfoResult({ modelId, name: "Weather Agent" });
  return {
    ...info,
    agent: {
      ...info.agent,
      model: {
        id: modelId,
        endpoint,
        routing: { kind: "gateway" as const, target: modelId.split("/")[0] ?? "openai" },
        ...extras,
      },
    },
  };
}

describe("TerminalRenderer (inline scrollback)", () => {
  it("prints the dim wordmark tag as the parting line after a Ctrl-C exit", async () => {
    const { screen, input, renderer } = makeRenderer();
    const prompt = readPrompt(renderer);
    // Ctrl-C at the prompt restores the terminal inside the reader itself;
    // the runner's teardown-time shutdown() must still print the tag.
    input.ctrlC();
    input.ctrlC();
    await expect(prompt).rejects.toThrow("Interrupted");
    renderer.shutdown();

    const lines = screen.snapshot().trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(/^☰eve {2}v\d+\.\d+\.\d+/u);
    expect(screen.rawOutput()).toContain(`\x1b[2m☰eve  v`);
    // Once, ever — repeated teardown must not repeat the tag.
    renderer.shutdown();
    expect(screen.snapshot().match(/☰eve/gu)).toHaveLength(1);

    // A renderer that never went live exits silently.
    const idle = makeRenderer();
    idle.renderer.shutdown();
    expect(idle.screen.snapshot()).not.toContain("☰eve");
  });

  it("names the session in the parting line once the runner reports it", async () => {
    const { screen, input, renderer } = makeRenderer();
    renderer.setSessionId("ses_0123456789");
    const prompt = readPrompt(renderer);
    input.ctrlC();
    input.ctrlC();
    await expect(prompt).rejects.toThrow("Interrupted");
    renderer.shutdown();

    const lines = screen.snapshot().trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(/^☰eve {2}v\d+\.\d+\.\d+ · session ses_0123456789$/u);

    // Repeated reports keep the latest id; a renderer that never received
    // one prints the bare tag.
    const latest = makeRenderer();
    latest.renderer.setSessionId("ses_first");
    latest.renderer.setSessionId("ses_second");
    const latestPrompt = readPrompt(latest.renderer);
    latest.input.ctrlC();
    latest.input.ctrlC();
    await expect(latestPrompt).rejects.toThrow("Interrupted");
    latest.renderer.shutdown();
    expect(latest.screen.snapshot()).toContain("session ses_second");
    expect(latest.screen.snapshot()).not.toContain("ses_first");
  });

  it("restores the terminal when a forced process exit preempts teardown", async () => {
    const before = process.listeners("exit");
    const { screen, input, renderer } = makeRenderer();
    const prompt = readPrompt(renderer);
    const added = process.listeners("exit").filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);

    // Simulate the lifecycle backstop's process.exit() firing mid-session.
    (added[0] as () => void)();
    expect(input.rawModes.at(-1)).toBe(false);
    expect(screen.rawOutput()).toContain("\x1b[?2004l"); // bracketed paste off
    expect(screen.rawOutput()).toContain("\x1b[?25h"); // cursor visible

    // A normal teardown removes the last-resort hook.
    input.ctrlC();
    input.ctrlC();
    await expect(prompt).rejects.toThrow("Interrupted");
    expect(process.listeners("exit")).toEqual(before);
  });

  it("commits the startup card before the prompt", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("gpt-5", {
        kind: "gateway",
        connected: true,
        credential: "api-key",
      }),
    });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toMatch(/☰eve v\d+\.\d+\.\d+ · Weather Agent · Run \/help for commands/u);
    expect(snapshot).not.toContain("http://localhost:3000");
  });

  it("uses an ASCII fallback for the turn pulse", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: false,
    });
    const prompt = readPrompt(renderer);

    input.type("hello");
    input.enter();

    expect(await prompt).toBe("hello");
    renderer.renderConversation(conversationOf([], { working: true }));
    expect(screen.snapshot()).toContain("* Thinking (0s)");
    expect(screen.snapshot()).not.toContain("⊙");
    renderer.shutdown();
  });

  it("reassembles and renders a byte-split multi-line paste", async () => {
    const { screen, input, renderer } = makeRenderer();
    const text = "first 😀\nsecond 界";

    const prompt = readPrompt(renderer);
    for (const byte of Buffer.from(`\x1b[200~${text}\x1b[201~`)) {
      input.emit("data", Buffer.of(byte));
    }

    const lines = screen.snapshot().split("\n");
    const firstRow = lines.findIndex((line) => line.includes("first 😀"));
    const secondRow = lines.findIndex((line) => line.includes("second 界"));
    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(secondRow).toBe(firstRow + 1);
    expect(screen.snapshot()).not.toContain("⏎");

    input.enter();
    expect(await prompt).toBe(text);
    renderer.shutdown();
  });

  it("clears and arms on the first idle Ctrl+C, then exits on a second press", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("draft message");
    input.ctrlC();
    expect(renderer.exitRequested()).toBe(false);
    expect(screen.snapshot()).toContain("Press Ctrl+C again to exit");
    input.type("real message");
    expect(screen.snapshot()).not.toContain("Press Ctrl+C again to exit");
    input.enter();

    // The cleared draft is gone (otherwise this would be "draft messagereal message").
    expect(await prompt).toBe("real message");

    // Consecutive Ctrl+C presses on the now-empty prompt quit.
    const second = readPrompt(renderer);
    input.ctrlC();
    expect(renderer.exitRequested()).toBe(false);
    expect(screen.snapshot()).toContain("Press Ctrl+C again to exit");
    input.ctrlC();
    await expect(second).rejects.toThrow();
    expect(renderer.exitRequested()).toBe(true);

    renderer.shutdown();
  });

  it("does not yank-pop after a controller-owned repaint key", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("one");
    input.send("\u0015"); // Ctrl+U
    input.type("two");
    input.send("\u0015"); // Ctrl+U
    input.send("\u0019"); // Ctrl+Y inserts "two"
    input.send("\u0012"); // Ctrl+R interrupts yank-pop
    input.send("\x1by"); // Alt+Y must not replace it with "one"
    input.enter();

    expect(await prompt).toBe("two");
    renderer.shutdown();
  });

  it("windows a line longer than the terminal around the caret", async () => {
    const { screen, input, renderer } = makeRenderer(20); // narrow terminal

    const prompt = readPrompt(renderer);
    input.type("abcdefghijklmnopqrstuvwxyz"); // 26 chars into ~18 columns of room

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("xyz"); // the caret end stays visible
    expect(snapshot).toContain("…"); // the truncated head is marked
    expect(snapshot).not.toContain("abcde"); // the head scrolled off

    input.enter();
    expect(await prompt).toBe("abcdefghijklmnopqrstuvwxyz"); // full text still submits
    renderer.shutdown();
  });

  it("draws the block cursor over the character under it without inserting a cell", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("hello");
    input.left();
    input.left(); // caret between "hel" and "lo"

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("hello"); // text stays contiguous, not split by a caret
    expect(snapshot).not.toContain("▏"); // no inserted bar-caret cell
    // The block caret is reverse-video (SGR 7) over the grapheme under the
    // cursor; snapshot() strips SGR, so assert it on the raw output.
    expect(screen.rawOutput()).toContain("\x1b[7m");

    input.enter();
    await prompt;
    renderer.shutdown();
  });

  it("recovers from an unterminated bracketed paste instead of wedging input", async () => {
    vi.useFakeTimers();
    try {
      const { input, renderer } = makeRenderer();
      const prompt = readPrompt(renderer);
      input.send("\x1b[200~first\nsecond"); // paste start, closing marker never arrives
      vi.advanceTimersByTime(1_100); // past the incomplete-paste flush
      input.type("X"); // input still works rather than being wedged
      input.enter();
      expect(await prompt).toBe("first\nsecondX");
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("inserts a newline on Shift+Enter and submits the whole multi-line buffer", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("line one");
    input.send("\x1b[27;2;13~"); // Shift+Enter (xterm modifyOtherKeys)
    input.type("line two");
    input.enter();

    expect(await prompt).toBe("line one\nline two");
    renderer.shutdown();
  });

  it("moves the caret into the line above on ↑, then edits it", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.send("\x1b[200~ab\ncd\x1b[201~"); // caret lands after "cd"
    input.up(); // to the end of "ab"
    input.type("X");
    input.enter();

    expect(await prompt).toBe("abX\ncd");
    renderer.shutdown();
  });

  it("bounds a tall prompt and moves its viewport with the caret", async () => {
    const { screen, input, renderer } = makeRenderer(40, 8);
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

    const prompt = readPrompt(renderer);
    input.send(`\x1b[200~${lines.join("\n")}\x1b[201~`);

    expect(screen.snapshot().split("\n").length).toBeLessThanOrEqual(8);
    expect(screen.snapshot()).toContain("line 20");
    expect(screen.snapshot()).toContain("…");

    for (let index = 0; index < 15; index += 1) input.up();

    expect(screen.snapshot()).toContain("line 5");
    expect(screen.snapshot()).not.toContain("line 20");

    input.type("X");
    input.enter();
    lines[4] += "X";
    expect(await prompt).toBe(lines.join("\n"));
    renderer.shutdown();
  });

  it("commits the one-line session boundary", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderNotice("anchor");
    renderer.renderSessionBoundary();
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("┌── Session restarted, clear context.");
  });

  it("never submits an empty or whitespace-only prompt", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.enter();
    input.type("   ");
    input.enter();
    // The reader is still armed: only real content resolves it.
    input.type("hello");
    input.enter();
    expect(await prompt).toBe("   hello");
    renderer.shutdown();
  });

  it("recalls a previous prompt with the up arrow", async () => {
    const { input, renderer } = makeRenderer();

    const first = readPrompt(renderer);
    input.type("first message");
    input.enter();
    expect(await first).toBe("first message");

    const second = readPrompt(renderer);
    input.type("draft");
    input.up();
    input.enter();
    // Up replaced the in-progress draft with the prior submission.
    expect(await second).toBe("first message");
    renderer.shutdown();
  });

  it("renders the setup attention line with a warning glyph and a blue command", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderSetupWarning("1 setup issue: AI Gateway credentials \u00b7 /model");

    // A live footer element, so assert while interactive (cleared on shutdown by
    // design \u2014 that is what lets it disappear once the issue is fixed).
    expect(screen.snapshot()).toContain(
      "\u26a0 1 setup issue: AI Gateway credentials \u00b7 /model",
    );
    expect(screen.rawOutput()).toContain("\u001b[34m/model");
    renderer.shutdown();
  });

  it("clears the setup attention line once its issue is resolved", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderSetupWarning("1 setup issue: not logged in · /deploy");
    expect(screen.snapshot()).toContain("not logged in");

    renderer.clearSetupWarning();
    expect(screen.snapshot()).not.toContain("not logged in");
    renderer.shutdown();
  });

  it("hangs a command outcome under its invocation with the elbow connector", () => {
    const { screen, renderer } = makeRenderer();
    renderer.finishCommand({ kind: "result", message: "/model dismissed." });
    renderer.shutdown();

    expect(screen.snapshot()).toContain("\u23bf  /model dismissed.");
  });

  it("strips complete ANSI styles from command outcomes", () => {
    const { screen, renderer } = makeRenderer();
    renderer.finishCommand({
      kind: "result",
      message: "Model changed to \u001b[1mchatgpt/gpt-5.6-sol\u001b[22m. Live on your next prompt.",
    });
    renderer.shutdown();

    expect(screen.snapshot()).toContain(
      "\u23bf  Model changed to chatgpt/gpt-5.6-sol. Live on your next prompt.",
    );
    expect(screen.snapshot()).not.toContain("[1m");
    expect(screen.snapshot()).not.toContain("[22m");
  });

  it("hangs a successful command outcome from an elbow into a full-intensity rail", () => {
    const { screen, renderer } = makeRenderer();
    renderer.finishCommand({
      kind: "result",
      message:
        "Registry items added: channel/photon-imessage.\n" +
        "Text your agent: +15550000000\n" +
        "Photon project: https://app.photon.codes/dashboard/project-id",
    });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("⎿  Registry items added: channel/photon-imessage.");
    expect(snapshot).toContain("      Text your agent: +15550000000");
    expect(snapshot).toContain(
      "      Photon project: https://app.photon.codes/dashboard/project-id",
    );
  });

  it("keeps a single-line successful command result under the elbow", () => {
    const { screen, renderer } = makeRenderer();
    renderer.finishCommand({ kind: "result", message: "Registry items added: connection/linear." });
    renderer.shutdown();

    expect(screen.snapshot()).toContain("⎿  Registry items added: connection/linear.");
  });

  it("pulses a running command's gutter", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandInvocation("/add connection/notion");

    expect(screen.snapshot()).toMatch(/^[▪ ] \/add connection\/notion$/m);
    expect(screen.snapshot()).not.toContain("│ /add connection/notion");
    renderer.shutdown();
  });

  it("holds a running command's gutter still while its setup panel pulses", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandInvocation("/deploy");
    renderer.setupFlow.begin("");

    expect(screen.snapshot()).toMatch(/^▪ \/deploy$/m);
    expect(screen.rawOutput()).toContain("\u001b[90m▪\u001b[39m /deploy");
    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("replaces a settled command with its dimmed summary", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandInvocation("/add connection/notion");
    renderer.finishCommand({ kind: "result", message: "", summary: "Added connection/notion" });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toMatch(/^\* Added connection\/notion$/m);
    expect(snapshot).not.toContain("/add connection/notion");
    expect(snapshot).not.toContain("⎿");
    expect(screen.rawOutput()).toContain("\u001b[2mAdded connection/notion");
  });

  it("hangs a settled command's details under its summary", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandInvocation("/add channel/slack");
    renderer.finishCommand({
      kind: "result",
      message: "Finish with `eve add channel/slack --skip-install`",
      summary: "Added channel/slack · setup not finished",
    });
    renderer.shutdown();

    expect(screen.snapshot()).toMatch(
      /^\* Added channel\/slack · setup not finished\n {3}⎿ {2}Finish with `eve add channel\/slack --skip-install`$/m,
    );
  });

  it("keeps the invocation when a settled command has no summary", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandInvocation("/deploy");
    renderer.finishCommand({ kind: "result", message: "Deployed: https://example.vercel.app" });
    renderer.shutdown();

    expect(screen.snapshot()).toMatch(
      /^\* \/deploy\n {3}⎿ {2}Deployed: https:\/\/example.vercel.app$/m,
    );
  });

  it("marks a failed automatic command and keeps its multiline outcome in one result block", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandInvocation("/deploy");
    renderer.finishCommand({
      kind: "result",
      message:
        "Authentication was refreshed, but example.vercel.app is unavailable: Access denied.\n\n" +
        "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
    });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toMatch(/^\* \/deploy$/m);
    expect(snapshot).toContain("⎿  Authentication was refreshed");
    expect(snapshot).toContain("TRUSTED_SOURCES_ENVIRONMENT_MISMATCH");
    expect(snapshot).not.toContain("· Authentication was refreshed");
  });

  it("invites with a quiet placeholder until typing starts", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    // A bare prompt before any info/turn has no status row (no ↑ 0 ↓ 0 counter).
    expect(screen.snapshot()).not.toContain("↑ 0");
    // Empty buffer: the default-color `❯` gutter with the message invitation.
    expect(screen.snapshot()).toContain("❯ Send a message…");
    expect(screen.rawOutput()).not.toContain("\x1b[48;5;");

    input.type("hello");
    // Typing colors the prompt mark and clears the invitation.
    expect(screen.snapshot()).toContain("❯ hello");
    expect(screen.snapshot()).not.toContain("Send a message…");
    input.enter();
    expect(await prompt).toBe("hello");
    renderer.shutdown();
  });

  it("retires the placeholder after the first user message", async () => {
    const { screen, input, renderer } = makeRenderer();

    const first = readPrompt(renderer);
    expect(screen.snapshot()).toContain("❯ Send a message…");
    input.type("hello");
    input.enter();
    expect(await first).toBe("hello");

    // Once the user has spoken, the empty prompt keeps the default-color `❯` but
    // drops the invitation text; typing still colors the active `❯`.
    const second = readPrompt(renderer);
    expect(screen.snapshot()).toContain("❯");
    expect(screen.snapshot()).not.toContain("Send a message…");
    input.type("again");
    expect(screen.snapshot()).toContain("❯ again");
    input.ctrlC();
    expect(screen.snapshot()).toContain("❯");
    input.ctrlC();
    await expect(second).rejects.toThrow();
    renderer.shutdown();
  });

  it("queues startup messages until the agent is ready", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const requestStop = vi.fn();
    const startupRenderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      onExitRequest: requestStop,
    });

    startupRenderer.beginStartupDraft({
      initialDraft: "weather",
      title: "weather-agent",
    });
    expect(screen.snapshot()).toContain("weather-agent");
    expect(screen.snapshot()).toContain("Run /help for commands");
    expect(screen.snapshot()).not.toContain("model");
    expect(screen.snapshot()).not.toContain("loading");
    expect(screen.snapshot()).toContain("Starting agent");
    expect(screen.snapshot()).toContain("weather");

    input.type(" tomorrow");
    input.enter();
    expect(screen.snapshot()).toContain("Queue 1/5");
    expect(screen.snapshot()).toContain("└ weather tomorrow");
    expect(screen.snapshot()).not.toContain("❯ weather tomorrow");

    input.type("and next week");
    input.enter();
    expect(screen.snapshot()).toContain("Queue 2/5");
    expect(screen.snapshot()).toContain("│ weather tomorrow");
    expect(screen.snapshot()).toContain("└ and next week");

    const startup = startupRenderer.finishStartupDraft();
    expect(startup).toEqual({
      draft: "",
      queuedPrompt: "weather tomorrow\n\nand next week",
    });

    const prompt = readPrompt(startupRenderer);
    expect(screen.snapshot()).not.toContain("Queue 1/5");
    input.ctrlC();
    input.ctrlC();
    await expect(prompt).rejects.toThrow();
    expect(requestStop).toHaveBeenCalledOnce();
    startupRenderer.shutdown();
  });

  it.each([32, 80])(
    "defers startup warnings until connection readiness at %i columns",
    (columns) => {
      const { renderer, screen } = makeRenderer(columns);
      renderer.beginStartupDraft({ initialDraft: "Hello Alice", title: "Agent" });
      renderer.renderSetupWarning("Model disconnected · /login");
      expect(screen.snapshot()).not.toContain("Model disconnected");
      renderer.setStartupPhase("connecting");
      expect(screen.snapshot()).toContain("Reading saved connection");
      expect(screen.snapshot()).not.toContain("Model disconnected");
      expect(renderer.finishStartupDraft()).toEqual({
        draft: "Hello Alice",
        queuedPrompt: undefined,
      });
      renderer.setStartupPhase(undefined);
      expect(screen.snapshot()).toContain("Model disconnected");
      renderer.shutdown();
    },
  );

  it.each([32, 80])(
    "keeps startup editable across connection work and questions at %i columns",
    async (columns) => {
      const { renderer, screen, input } = makeRenderer(columns);
      renderer.beginStartupDraft({ initialDraft: "Hello", title: "Agent" });
      const composerRow = screen
        .snapshot()
        .split("\n")
        .findIndex((line) => line.includes("Hello"));
      renderer.setStartupPhase("connecting");
      renderer.setupFlow.begin("Connect a model");
      const interrupt = renderer.setupFlow.waitForInterrupt();
      renderer.setupFlow.setStatus("Connecting with Vercel…");
      expect(screen.snapshot()).toContain("Connecting with Vercel");
      expect(screen.snapshot()).not.toContain("Connect a model");
      expect(screen.snapshot()).not.toContain("Working");
      expect(
        screen
          .snapshot()
          .split("\n")
          .findIndex((line) => line.includes("Hello")),
      ).toBe(composerRow);
      input.type(" 世界");
      expect(screen.snapshot()).toContain("Hello 世界");
      const answer = renderer.setupFlow.readSelect({
        kind: "search",
        message: "Connect a model",
        options: [
          { value: "vercel", label: "Vercel Account" },
          { value: "openai", label: "OpenAI API Key" },
        ],
      });
      expect(screen.snapshot()).toContain("Connect a model");
      expect(screen.snapshot()).not.toContain("Hello 世界");
      input.type("OpenAI");
      input.enter();
      await expect(answer).resolves.toEqual(["openai"]);
      renderer.setupFlow.setStatus("Checking connection…");
      input.type("!");
      expect(screen.snapshot()).toContain("Hello 世界!");
      input.enter();
      renderer.setStartupPhase("updating");
      renderer.setupFlow.setStatus("Loading selected model…");
      input.type("Next message");
      expect(screen.snapshot()).toContain("Loading selected model");
      expect(screen.snapshot()).not.toContain("Working");
      interrupt.dispose();
      renderer.setupFlow.end({ preserveDiagnostics: false });
      input.type(" too");
      expect(renderer.finishStartupDraft()).toEqual({
        draft: "Next message too",
        queuedPrompt: "Hello 世界!",
      });
      renderer.setStartupPhase(undefined);
      renderer.shutdown();
    },
  );

  it("restores the startup draft after a masked key question is cancelled", async () => {
    const { renderer, input, screen } = makeRenderer();
    renderer.beginStartupDraft({ initialDraft: "My message", title: "Agent" });
    renderer.setupFlow.begin("Connect a model");
    const answer = renderer.setupFlow.readText({ message: "API key", mask: true });
    input.type("private-test-key");
    expect(screen.snapshot()).not.toContain("private-test-key");
    input.send("\x1b");
    await expect(answer).resolves.toBeUndefined();
    renderer.setupFlow.end({ preserveDiagnostics: false });
    expect(screen.snapshot()).toContain("My message");
    expect(renderer.finishStartupDraft().draft).toBe("My message");
    renderer.setStartupPhase(undefined);
    renderer.shutdown();
  });

  it("lets Ctrl-C stop an editing-only startup draft", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const requestStop = vi.fn();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      onExitRequest: requestStop,
    });

    renderer.beginStartupDraft({
      title: "weather-agent",
    });
    input.ctrlC();

    expect(requestStop).toHaveBeenCalledOnce();
    renderer.shutdown();
  });

  it("seeds the editable buffer with an initial draft without auto-submitting", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer, { initialDraft: "hello world" });
    // The seed is shown and the placeholder is suppressed — but no submit
    // happens until the user presses Enter, so they can edit it first.
    expect(screen.snapshot()).toContain("hello world");
    expect(screen.snapshot()).not.toContain("Type to chat");

    input.type("!");
    input.enter();
    expect(await prompt).toBe("hello world!");
    renderer.shutdown();
  });

  it("strips control characters from an initial draft", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer, {
      initialDraft: "safe\u001b[2Jafter\nnext\tvalue\u007f",
    });
    input.enter();

    expect(await prompt).toBe("safe[2Jafternextvalue");
    renderer.shutdown();
  });

  it("keeps the placeholder away from freeform question input", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Anything else?",
      display: "text",
    });
    expect(screen.snapshot()).not.toContain("Type to chat");
    input.type("no");
    input.enter();
    await answer;
    expect(screen.snapshot()).not.toContain("Send a message…");
    renderer.shutdown();
  });

  it("preserves bracketed multi-line paste in freeform question input", async () => {
    const { input, renderer } = makeRenderer();

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "What city are you in?",
      display: "text",
      options: [],
      allowFreeform: true,
    });
    input.send("\x1b[200~New\nYork\x1b[201~");
    input.enter();

    await expect(answer).resolves.toEqual({ text: "New\nYork" });
    renderer.shutdown();
  });

  it("renders the question drawer with shared option rows", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Choose access",
      display: "select",
      options: [
        { id: "gateway", label: "AI Gateway", description: "Managed access" },
        { id: "external", label: "Other providers", description: "Direct access" },
      ],
    });

    const snapshot = screen.snapshot();
    const lines = snapshot.split("\n");
    const selected = lines.find((line) => line.includes("AI Gateway"));
    expect(selected).toBe("     AI Gateway");
    expect(selected).not.toContain("↵");
    expect(selected).not.toContain("1.");
    expect(screen.rawOutput()).not.toContain("\x1b[7m");
    expect(screen.rawOutput()).toContain("\x1b[1m");
    // Every option's description rides its own row, cursor or not.
    expect(lines).toContain("     Managed access");
    expect(lines).toContain("     Direct access");
    // The drawer carries selection and dismissal controls; no status row
    // appears beneath it.
    expect(snapshot).toContain("esc to dismiss");
    expect(snapshot).toContain("enter to select");
    expect(snapshot).toContain("↑/↓ move");
    expect(countOccurrences(snapshot, "esc to dismiss")).toBe(1);

    input.send("j");
    const unselected = screen
      .snapshot()
      .split("\n")
      .find((line) => line.includes("AI Gateway"));
    expect(unselected).toContain("AI Gateway");
    expect(unselected).not.toContain("›");
    input.send("k");

    input.enter();
    await expect(answer).resolves.toEqual({ optionId: "gateway" });
    // The committed transcript hangs the answer under the question's elbow.
    expect(screen.snapshot()).toContain("? Choose access");
    expect(screen.snapshot()).toContain("⎿  AI Gateway");
    renderer.shutdown();
  });

  it("dismisses the question with Esc, recording it compactly", async () => {
    const { screen, input, renderer } = makeRenderer();
    // A lone ESC is held briefly in case it starts an arrow sequence.
    const escape = async () => {
      input.send("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Choose access",
      display: "select",
      options: [
        { id: "gateway", label: "AI Gateway", description: "Managed access" },
        { id: "external", label: "Other providers", description: "Direct access" },
      ],
    });
    expect(screen.snapshot()).toContain("esc to dismiss");

    await escape();
    // No answer travels; the runner returns to the prompt and the question
    // stays open for the next message.
    await expect(answer).resolves.toBeUndefined();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("? Choose access");
    expect(snapshot).toContain("⎿  Skipped. The question stays open.");
    // The option list does not survive the dismissal.
    expect(snapshot).not.toContain("Managed access");
    expect(snapshot).not.toContain("Enter to select");
    renderer.shutdown();
  });

  it("clears a freeform draft on the first Esc and dismisses on the second", async () => {
    const { screen, input, renderer } = makeRenderer();
    const escape = async () => {
      input.send("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Choose access",
      display: "select",
      options: [{ id: "gateway", label: "AI Gateway" }],
      allowFreeform: true,
    });
    input.down();
    expect(screen.snapshot()).toContain("Type your own answer…");
    expect(screen.rawOutput()).toContain("\x1b[7m");
    input.type("draft answer");
    expect(screen.snapshot()).toContain("draft answer");

    await escape();
    expect(screen.snapshot()).not.toContain("draft answer");
    expect(screen.snapshot()).toContain("esc to dismiss");

    await escape();
    await expect(answer).resolves.toBeUndefined();
    expect(screen.snapshot()).toContain("⎿  Skipped. The question stays open.");
    renderer.shutdown();
  });

  it("focuses the freeform editor when the cursor reaches its row", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Choose access",
      display: "select",
      options: [
        { id: "gateway", label: "AI Gateway" },
        { id: "external", label: "Other providers" },
      ],
      allowFreeform: true,
    });

    expect(screen.snapshot()).toContain("Type your own answer…");
    // Moving to the freeform row focuses its inline editor; typing lands
    // there without a separate enter.
    input.down();
    input.down();
    expect(screen.rawOutput()).toContain("\x1b[7m");
    input.type("neither");
    expect(screen.snapshot()).toContain("neither");
    input.enter();

    await expect(answer).resolves.toEqual({ text: "neither" });
    renderer.shutdown();
  });

  it("dismisses a text question with Esc once its draft is cleared", async () => {
    const { screen, input, renderer } = makeRenderer();
    const escape = async () => {
      input.send("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "What city are you in?",
      display: "text",
    });
    input.type("New York");
    await escape();
    // First Esc only clears the draft; the question drawer stays open.
    expect(screen.snapshot()).toContain("What city are you in?");
    expect(screen.snapshot()).toContain("Enter submit · Esc dismiss");

    await escape();
    await expect(answer).resolves.toBeUndefined();
    expect(screen.snapshot()).toContain("⎿  Skipped. The question stays open.");
    renderer.shutdown();
  });

  it("edits freeform question input across lines", async () => {
    const { input, renderer } = makeRenderer();

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "What should I know?",
      display: "text",
    });
    input.type("first");
    input.send("\x1b[27;2;13~");
    input.type("second");
    input.up();
    input.type("!");
    input.enter();

    await expect(answer).resolves.toEqual({ text: "first!\nsecond" });
    renderer.shutdown();
  });

  it("clears non-empty freeform question input on Ctrl+C before interrupting", async () => {
    const { input, renderer } = makeRenderer();
    const question = {
      requestId: "q1",
      prompt: "What city are you in?",
      display: "text",
      options: [],
      allowFreeform: true,
    } satisfies Parameters<typeof renderer.readInputQuestion>[0];

    const answer = renderer.readInputQuestion(question);
    input.type("New York");
    input.ctrlC();
    input.type("Boston");
    input.enter();
    await expect(answer).resolves.toEqual({ text: "Boston" });

    const interrupted = renderer.readInputQuestion({ ...question, requestId: "q2" });
    input.ctrlC();
    await expect(interrupted).rejects.toThrow();
    renderer.shutdown();
  });

  it("leaves a fully typed known command as plain text in the input line", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("/add");
    expect(screen.rawOutput()).not.toContain("[1m/add");
    expect(screen.rawOutput()).not.toContain("[34m/add");
    input.enter();
    await prompt;
    renderer.shutdown();
  });

  it("leaves unknown input unstyled in the input line", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    // Never passes through a known command, even if painted per keystroke
    // ("/li…" is not a known command).
    input.type("/lin is not a command");
    expect(screen.rawOutput()).not.toContain("[1m/lin is not a command");
    input.enter();
    await prompt;
    renderer.shutdown();
  });

  it("echoes slash commands as command lines, never as user messages", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("/reset");
    input.enter();
    expect(await prompt).toBe("/reset");
    renderer.shutdown();

    // The echo anchors in the user-message grammar (gutter bar), never the
    // prompt glyph: that one is the live-input rendezvous marker.
    expect(screen.snapshot()).toContain("\u2502 /reset");
    expect(screen.snapshot()).not.toContain("\u276f /reset");
  });

  it("reassembles an arrow key split across reads", async () => {
    const { input, renderer } = makeRenderer();

    const first = readPrompt(renderer);
    input.type("remembered");
    input.enter();
    await first;

    const second = readPrompt(renderer);
    input.send("\x1b"); // ESC arrives on its own…
    input.send("[A"); // …and the CSI tail follows in a later read.
    input.enter();
    expect(await second).toBe("remembered");
    renderer.shutdown();
  });

  it("inserts text at the caret after moving left", async () => {
    const { input, renderer } = makeRenderer();
    const prompt = readPrompt(renderer);
    input.type("helo");
    input.left();
    input.type("l");
    input.enter();
    expect(await prompt).toBe("hello");
    renderer.shutdown();
  });

  it("coalesces a source's writes into one section showing the newest write", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "all",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write("weather lookup { city: 'NY' }\n");
    process.stdout.write("weather lookup { city: 'LA' }\n");
    renderer.renderNotice("turn boundary");
    process.stdout.write("post-turn line\n");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // A stream is continuous: every stdout write — the notice interleaving
    // included — merges into ONE section anchored at the newest write,
    // showing only that write with the rest behind the elided count.
    expect(countOccurrences(snapshot, "○ stdout")).toBe(1);
    expect(snapshot).toContain("│ … (2 more)");
    expect(snapshot).toContain("│ post-turn line");
    expect(snapshot).not.toContain("city: 'NY'");
    // The section sits at the last write's position — after the notice.
    expect(snapshot.indexOf("○ stdout")).toBeGreaterThan(snapshot.indexOf("turn boundary"));
  });

  it("retroactively hides and restores buffered logs when the level changes", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "all",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write("before-boundary stdout\n");
    renderer.renderNotice("turn boundary");
    process.stderr.write("after-boundary stderr\n");

    renderer.setLogDisplayMode("none");
    const hidden = screen.snapshot();
    expect(hidden).not.toContain("before-boundary stdout");
    expect(hidden).not.toContain("after-boundary stderr");
    expect(hidden).toContain("turn boundary");

    renderer.setLogDisplayMode("all");
    renderer.shutdown();

    // Restored sections sit at their newest write's position: stdout
    // before the notice, stderr after it — later events display after the
    // last error, never behind it.
    const restored = screen.snapshot();
    expect(restored.indexOf("before-boundary stdout")).toBeGreaterThan(-1);
    expect(restored.indexOf("before-boundary stdout")).toBeLessThan(
      restored.indexOf("turn boundary"),
    );
    expect(restored.indexOf("turn boundary")).toBeLessThan(
      restored.indexOf("after-boundary stderr"),
    );
  });

  it("stores long stderr diagnostics and shows concise copy by default", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const stub = stubDiagnostics();
    const append = stub.append;
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "stderr",
      unicode: true,
      diagnostics: stub.diagnostics,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    const detail = [
      "Error: request returned 403",
      "  at first",
      "  at second",
      "  at third",
      "  at fourth",
    ].join("\n");

    process.stderr.write(`${detail}\n`);

    expect(append).toHaveBeenCalledWith({ source: "stderr", detail });
    expect(screen.snapshot()).toContain("Error: request returned 403");
    expect(screen.snapshot()).toContain("details: .eve/logs/dev.log");
    expect(screen.snapshot()).not.toContain("at fourth");

    renderer.setLogDisplayMode("all");
    expect(screen.snapshot()).toContain("at fourth");
    expect(screen.snapshot()).not.toContain("details: .eve/logs/dev.log");

    process.stdout.write("server listening on 3000\n");
    expect(append).toHaveBeenCalledWith({ source: "stdout", detail: "server listening on 3000" });
    renderer.shutdown();
  });

  it("subscribes the recorder to log records, displays them, and releases on shutdown", () => {
    const screen = new MockScreen({ columns: 120, rows: 30 });
    const input = new MockUserInput();
    const stub = stubDiagnostics();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "stderr",
      unicode: true,
      diagnostics: stub.diagnostics,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    expect(stub.subscribed).toBe(true);
    stub.emitLogRecord({
      level: "error",
      namespace: "harness.tool-loop",
      message: "tool execution failed",
      fields: { toolName: "always_fail" },
    });
    expect(screen.snapshot()).toContain("[eve:harness.tool-loop] tool execution failed");

    renderer.shutdown();
    expect(stub.subscribed).toBe(false);
  });

  it("records captured sandbox log lines in the diagnostic log", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const stub = stubDiagnostics();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      unicode: true,
      diagnostics: stub.diagnostics,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    process.stdout.write('eve: sandbox template "root" (microsandbox): apt-get update\n');
    renderer.shutdown();
    expect(stub.append).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "stdout",
        detail: expect.stringContaining("apt-get update"),
      }),
    );
  });

  it("shows delayed build progress and immediate completion when logs are hidden", () => {
    vi.useFakeTimers();
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      unicode: true,
    });
    try {
      renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

      process.stdout.write(
        `${formatChangeDetectedLogLine("/app", [
          { event: "change", path: "/app/agent/instructions.md" },
        ])}\n`,
      );
      expect(renderer.logDisplayMode()).toBe("none");
      expect(screen.snapshot()).not.toContain("agent/instructions.md changed");
      expect(screen.snapshot()).not.toContain("○ stdout");

      vi.advanceTimersByTime(250);
      expect(screen.snapshot()).toContain("▪ agent/instructions.md updating…");

      process.stdout.write(`${AUTHORED_ARTIFACTS_UPDATED_LOG_LINE}\n`);
      expect(screen.snapshot()).toContain("✓ agent/instructions.md updated");

      vi.advanceTimersByTime(4_000);
      expect(screen.snapshot()).not.toContain("✓ agent/instructions.md updated");

      process.stdout.write(
        `${formatChangeDetectedLogLine("/app", [
          { event: "change", path: "/app/agent/agent.ts" },
        ])}\n`,
      );
      process.stdout.write(`${AUTHORED_ARTIFACTS_UPDATED_LOG_LINE}\n`);
      expect(screen.snapshot()).toContain("✓ agent/agent.ts updated");
      expect(screen.snapshot()).not.toContain("agent/agent.ts updating");
    } finally {
      renderer.shutdown();
      vi.useRealTimers();
    }
  });

  it("hides logs by default, then reveals buffered lines at their original positions", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write("captured while hidden\n");
    renderer.renderNotice("after the log");
    expect(renderer.logDisplayMode()).toBe("none");
    expect(screen.snapshot()).not.toContain("captured while hidden");

    renderer.setLogDisplayMode("all");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // The buffered write reappears at its own position, before the notice
    // that followed it.
    expect(snapshot.indexOf("captured while hidden")).toBeGreaterThan(-1);
    expect(snapshot.indexOf("captured while hidden")).toBeLessThan(
      snapshot.indexOf("after the log"),
    );
  });

  it("keeps a hidden write out of the stream section until its filter shows it", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      unicode: true,
      logs: "stderr",
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stderr.write("first stderr line\n");
    process.stdout.write("interleaved stdout line\n");
    process.stderr.write("second stderr line\n");

    // Both stderr writes merge into one stream section; the hidden stdout
    // write contributes no section of its own.
    expect(countOccurrences(screen.snapshot(), "○ stderr")).toBe(1);
    expect(screen.snapshot()).not.toContain("○ stdout");

    renderer.setLogDisplayMode("all");
    renderer.shutdown();

    // Once visible, stdout gets its own section; the stderr stream stays
    // whole and ordered.
    const snapshot = screen.snapshot();
    expect(countOccurrences(snapshot, "○ stderr")).toBe(1);
    expect(countOccurrences(snapshot, "○ stdout")).toBe(1);
    expect(snapshot.indexOf("first stderr line")).toBeLessThan(
      snapshot.indexOf("second stderr line"),
    );
    expect(snapshot).toContain("interleaved stdout line");
  });

  it("shows sandbox stdout lines and hides ordinary stdout under the sandbox log level", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "sandbox",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write('eve: sandbox template "root" (microsandbox): checking cached snapshot\n');
    process.stdout.write("eve: initializing 3 sandbox templates...\n");
    process.stdout.write('eve: built sandbox template "root" on backend "microsandbox".\n');
    process.stdout.write("ordinary stdout log\n");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain(
      'sandbox · built sandbox template "root" on backend "microsandbox".',
    );
    expect(snapshot).not.toContain("initializing 3 sandbox templates");
    expect(snapshot).not.toContain("checking cached snapshot");
    expect(snapshot).not.toContain("ordinary stdout log");
    expect(snapshot).not.toContain("○ stdout");
    expect(snapshot).not.toContain("○ stderr");
  });

  it("hides sandbox lines under the none log level", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "none",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write('eve: built sandbox template "root" on backend "microsandbox".\n');
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("sandbox ·");
    expect(snapshot).not.toContain("built sandbox template");
  });

  it("shows sandbox and stdout lines together under the all log level", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "all",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write('eve: built sandbox template "root" on backend "microsandbox".\n');
    process.stdout.write("ordinary stdout log\n");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain(
      'sandbox · built sandbox template "root" on backend "microsandbox".',
    );
    expect(snapshot).toContain("ordinary stdout log");
  });

  it("renders captured lazy preparation logs under the sandbox log level", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "sandbox",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write('eve: sandbox template "root" (docker): checking Docker daemon\n');
    process.stdout.write("eve: initializing 3 sandbox templates...\n");
    process.stdout.write('eve: built sandbox template "root" on backend "docker".\n');
    process.stdout.write("ordinary stdout log\n");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain('sandbox · built sandbox template "root" on backend "docker".');
    expect(snapshot).not.toContain("initializing 3 sandbox templates");
    expect(snapshot).not.toContain("checking Docker daemon");
    expect(snapshot).not.toContain("ordinary stdout log");
    expect(snapshot).not.toContain("○ stdout");
  });

  it("cycles the log mode on Ctrl+L with a transient status hint that clears after 5s", () => {
    vi.useFakeTimers();
    try {
      const screen = new MockScreen({ columns: 100, rows: 30 });
      const input = new MockUserInput();
      const renderer = new TerminalRenderer({ input, output: screen, unicode: true });
      // Abandoned on purpose; shutdown() rejects it with InterruptedError.
      readPrompt(renderer).catch(() => {});

      // Ctrl+R only redraws — it must not cycle the mode or show the hint.
      input.type("\u0012");
      expect(renderer.logDisplayMode()).toBe("none");
      expect(screen.snapshot()).not.toContain("logs:");

      input.type("\u000c"); // Ctrl+L: none → all
      expect(renderer.logDisplayMode()).toBe("all");
      expect(screen.snapshot()).toContain("logs: all");

      input.type("\u000c"); // Ctrl+L: all → stderr
      expect(renderer.logDisplayMode()).toBe("stderr");
      expect(screen.snapshot()).toContain("logs: stderr");

      // The hint clears after 5s of no further cycling; the mode itself stays.
      vi.advanceTimersByTime(5_000);
      expect(screen.snapshot()).not.toContain("logs:");
      expect(renderer.logDisplayMode()).toBe("stderr");

      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cycles dev rebuild log lines through one in-place status row", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "all",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write(
      `${formatChangeDetectedLogLine("/app", [{ event: "change", path: "/app/agent/agent.ts" }])}\n`,
    );
    process.stdout.write(`${AUTHORED_ARTIFACTS_UPDATED_LOG_LINE}\n`);
    process.stdout.write(
      `${formatChangeDetectedLogLine("/app", [
        { event: "change", path: "/outside/src/cli/dev/tui/setup-panel.ts" },
      ])}\n`,
    );
    process.stdout.write(`${AUTHORED_ARTIFACTS_UPDATED_LOG_LINE}\n`);

    // Only the latest cycle shows: condensed, path shortened to its last two
    // components, the earlier cycle replaced in place.
    const live = screen.snapshot();
    expect(live).toContain("tui/setup-panel.ts changed · rebuilt");
    expect(live).not.toContain("agent/agent.ts");
    expect(live).not.toContain("change detected");
    expect(live).not.toContain("/outside/src");
    expect(countOccurrences(live, "○ stdout")).toBe(1);

    // Shutdown settles the status row into scrollback instead of wiping it.
    renderer.shutdown();
    expect(screen.snapshot()).toContain("tui/setup-panel.ts changed · rebuilt");
  });

  it("updates the rebuild status before the watcher writes a newline", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "all",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write(
      formatChangeDetectedLogLine("/app", [{ event: "change", path: "/app/package.json" }]),
    );

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("package.json changed · rebuilding…");
    expect(snapshot).not.toContain("[eve:dev] change detected");
    renderer.shutdown();
  });

  it("flips the status row to reloading on a structural change", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "all",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write(
      `${formatChangeDetectedLogLine("/app", [{ event: "change", path: "/app/.env.local" }])}\n`,
    );
    process.stdout.write(`${STRUCTURAL_RELOAD_LOG_LINE}\n`);
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain(".env.local changed · reloading server…");
    expect(snapshot).not.toContain("Nitro worker");
  });

  it("settles the in-place rebuild status when other output interleaves", () => {
    const screen = new MockScreen({ columns: 100, rows: 40 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "all",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stdout.write(
      `${formatChangeDetectedLogLine("/app", [{ event: "change", path: "/app/agent/agent.ts" }])}\n`,
    );
    renderer.renderNotice("turn boundary");
    // The cycle was settled by the notice — the orphaned outcome line falls
    // back to an ordinary log line so it isn't lost…
    process.stdout.write(`${AUTHORED_ARTIFACTS_UPDATED_LOG_LINE}\n`);
    // …and the next change opens a fresh in-place cycle.
    process.stdout.write(
      `${formatChangeDetectedLogLine("/app", [
        { event: "change", path: "/app/agent/tools/lookup.ts" },
      ])}\n`,
    );
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot.indexOf("agent/agent.ts changed · rebuilding…")).toBeGreaterThan(-1);
    expect(snapshot.indexOf("agent/agent.ts changed · rebuilding…")).toBeLessThan(
      snapshot.indexOf("turn boundary"),
    );
    expect(snapshot.indexOf("turn boundary")).toBeLessThan(
      snapshot.indexOf(AUTHORED_ARTIFACTS_UPDATED_LOG_LINE),
    );
    // The orphaned outcome line is an ordinary write now — it rides the
    // stream section at the live edge, after the in-place status row.
    expect(snapshot).toContain("tools/lookup.ts changed · rebuilding…");
  });

  it("delays dev rebuild errors until explicitly flushed", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "stderr",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stderr.write("[eve:dev] rebuild failed: expected default export\n");

    expect(screen.snapshot()).not.toContain("expected default export");

    renderer.flushDelayedDevBuildErrors();

    expect(screen.snapshot()).toContain("│ [eve:dev] rebuild failed");
    expect(screen.snapshot()).toContain("expected default export");
    renderer.shutdown();
  });

  it("delays multi-line dev rebuild errors as one block", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "stderr",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stderr.write("[eve:dev] rebuild failed: first line\nsecond line\n");

    expect(screen.snapshot()).not.toContain("first line");
    expect(screen.snapshot()).not.toContain("second line");

    renderer.flushDelayedDevBuildErrors();

    expect(screen.snapshot()).toContain("first line");
    expect(screen.snapshot()).toContain("second line");
    renderer.shutdown();
  });

  it("drops delayed dev rebuild errors after a successful rebuild", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "stderr",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stderr.write("[eve:dev] rebuild failed: missing export\n");
    process.stdout.write(`${AUTHORED_ARTIFACTS_UPDATED_LOG_LINE}\n`);
    renderer.flushDelayedDevBuildErrors();

    expect(screen.snapshot()).not.toContain("missing export");
    renderer.shutdown();
  });

  it("shows dev rebuild errors immediately when all logs are enabled", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: true,
      logs: "all",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    process.stderr.write("[eve:dev] rebuild failed: missing export\n");

    expect(screen.snapshot()).toContain("│ [eve:dev] rebuild failed");
    expect(screen.snapshot()).toContain("missing export");
    renderer.shutdown();
  });

  it("renders tool approval in a drawer", async () => {
    const { screen, input, renderer } = makeRenderer();
    const approval = renderer.readToolApproval({
      approvalId: "a1",
      toolCallId: "c1",
      toolName: "random_color",
      input: {},
    });

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("\n\n─");
    expect(snapshot).toContain("Approve random_color?");
    const yes = snapshot.split("\n").find((row) => row.includes("Yes"));
    expect(yes).toBe("     Yes");
    expect(snapshot).toContain("No");
    expect(snapshot).toContain("y yes · n no · Ctrl-C cancel");
    expect(snapshot).not.toContain("(y/n)");
    input.down();
    expect(
      screen
        .snapshot()
        .split("\n")
        .find((row) => row.includes("No")),
    ).toBe("     No");
    input.up();
    input.enter();

    await expect(approval).resolves.toEqual({ approved: true });
    renderer.shutdown();
  });

  it("clears a pending approval drawer when interrupted externally", async () => {
    const { screen, renderer } = makeRenderer();
    const approval = renderer.readToolApproval({
      approvalId: "a1",
      toolCallId: "c1",
      toolName: "random_color",
      input: {},
    });
    expect(screen.snapshot()).toContain("Approve random_color?");

    renderer.requestInterrupt();
    await expect(approval).rejects.toThrow();

    const prompt = readPrompt(renderer);
    expect(screen.snapshot()).not.toContain("Approve random_color?");
    renderer.requestInterrupt();
    await expect(prompt).rejects.toThrow();
    renderer.shutdown();
  });

  it("stops the turn ticker while a later human-input request is open", async () => {
    vi.useFakeTimers();
    try {
      const { screen, input, renderer } = makeRenderer();

      const firstApproval = renderer.readToolApproval({
        approvalId: "a1",
        toolCallId: "c1",
        toolName: "read_file",
        input: { path: "README.md" },
      });
      input.type("y");
      await firstApproval;

      const question = renderer.readInputQuestion({
        requestId: "q1",
        prompt: "Continue?",
        display: "select",
        options: [{ id: "yes", label: "Yes" }],
      });
      const questionOutputLength = screen.rawOutput().length;
      vi.advanceTimersByTime(300);
      expect(screen.rawOutput()).toHaveLength(questionOutputLength);
      input.enter();
      await question;

      const secondApproval = renderer.readToolApproval({
        approvalId: "a2",
        toolCallId: "c2",
        toolName: "write_file",
        input: { path: "README.md" },
      });
      const approvalOutputLength = screen.rawOutput().length;
      vi.advanceTimersByTime(300);
      expect(screen.rawOutput()).toHaveLength(approvalOutputLength);
      input.type("n");
      await secondApproval;
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat bracketed-paste text as a tool approval action", async () => {
    const { input, renderer } = makeRenderer();
    const approval = renderer.readToolApproval({
      approvalId: "a1",
      toolCallId: "c1",
      toolName: "delete_files",
      input: { path: "/" },
    });

    input.send("\x1b[200~y\x1b[201~");
    input.type("n");

    await expect(approval).resolves.toEqual({ approved: false, reason: "Denied by user." });
    renderer.shutdown();
  });

  it("does not treat an unterminated bracketed paste as a tool approval action", async () => {
    vi.useFakeTimers();
    try {
      const { input, renderer } = makeRenderer();
      const approval = renderer.readToolApproval({
        approvalId: "a1",
        toolCallId: "c1",
        toolName: "delete_files",
        input: { path: "/" },
      });

      input.send("\x1b[200~y");
      vi.advanceTimersByTime(1_100);
      input.type("n");

      await expect(approval).resolves.toEqual({ approved: false, reason: "Denied by user." });
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits a dim recovery notice to scrollback", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.renderNotice("Session ended — started a new session.");
    renderer.shutdown();
    expect(screen.snapshot()).toContain("Session ended — started a new session.");
  });

  it("does not repeat the banner when a source reload re-sends an unchanged header", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.renderNotice("previous transcript");

    // Every runtime-artifacts change re-sends the header; an identical one
    // must not stack another banner under the transcript.
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.shutdown();

    expect(countOccurrences(screen.snapshot(), "☰eve v")).toBe(1);
  });

  it("reset clears committed transcript rows", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.renderNotice("previous transcript");
    expect(screen.snapshot()).toContain("previous transcript");

    renderer.reset();
    renderer.shutdown();

    expect(screen.snapshot()).not.toContain("previous transcript");
    expect(screen.snapshot()).not.toContain("Weather Agent");
  });
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) return count;
    count += 1;
    index = next + needle.length;
  }
}

describe("TerminalRenderer setup panel", () => {
  it("resolves a single select from arrow navigation and clears the panel", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      message: "Vercel project",
      options: [
        { value: "new", label: "Create a new project" },
        { value: "link", label: "Link an existing project" },
      ],
    });
    expect(screen.snapshot()).toContain("Vercel project");

    input.down();
    input.enter();
    await expect(answer).resolves.toEqual(["link"]);

    renderer.shutdown();
    expect(screen.snapshot()).not.toContain("esc to cancel");
  });

  it("cancels the panel with escape", async () => {
    const { input, renderer } = makeRenderer();

    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      message: "Vercel project",
      options: [{ value: "new", label: "Create a new project" }],
    });
    input.send("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(answer).resolves.toBeUndefined();
    renderer.shutdown();
  });

  it("returns from a planner review with Left Arrow instead of selecting an action", async () => {
    const { screen, input, renderer } = makeRenderer();
    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      navigation: {
        kind: "planner",
        activeStep: 2,
        steps: [{ label: "Channels" }, { label: "Integrations" }, { label: "Review" }],
      },
      message: "Review your agent",
      options: [
        { value: "install", label: "Install and set up" },
        { value: "back", label: "Back" },
      ],
    });

    expect(screen.snapshot()).toContain("enter to select · ← back · esc to cancel");
    input.left();
    await expect(answer).resolves.toEqual({
      kind: "navigate",
      direction: "back",
      values: [],
    });
    renderer.shutdown();
  });

  it("ignores arrow navigation before the first navigable planner step", async () => {
    const { input, renderer } = makeRenderer();
    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      navigation: {
        kind: "planner",
        activeStep: 0,
        firstNavigableStep: 1,
        steps: [{ label: "Model" }, { label: "Channels" }, { label: "Integrations" }],
      },
      message: "Choose a model",
      options: [{ value: "model", label: "Use recommended model" }],
    });

    input.left();
    input.right();
    input.enter();
    await expect(answer).resolves.toEqual(["model"]);
    renderer.shutdown();
  });

  it("ignores Left Arrow on the first navigable planner step", async () => {
    const { input, renderer } = makeRenderer();
    const answer = renderer.setupFlow.readSelect({
      kind: "searchable-multi",
      navigation: {
        kind: "planner",
        activeStep: 1,
        firstNavigableStep: 1,
        steps: [{ label: "Model" }, { label: "Channels" }, { label: "Integrations" }],
      },
      message: "Where should people reach your agent?",
      options: [{ value: "web", label: "Web Chat" }],
      required: false,
    });

    input.left();
    input.enter();
    input.right();
    await expect(answer).resolves.toEqual({
      kind: "navigate",
      direction: "forward",
      values: ["web"],
    });
    renderer.shutdown();
  });

  it("proceeds from a planner checklist with Right Arrow and preserves its selections", async () => {
    const { screen, input, renderer } = makeRenderer();
    const answer = renderer.setupFlow.readSelect({
      kind: "searchable-multi",
      navigation: {
        kind: "planner",
        activeStep: 0,
        steps: [{ label: "Channels" }, { label: "Integrations" }, { label: "Review" }],
      },
      message: "Where should people reach your agent?",
      options: [
        { value: "web", label: "Web Chat" },
        { value: "slack", label: "Slack" },
      ],
      required: false,
    });

    expect(screen.snapshot()).not.toContain("Channels (1)");
    input.enter();
    expect(screen.snapshot()).toContain("Channels (1)");
    input.right();
    await expect(answer).resolves.toEqual({
      kind: "navigate",
      direction: "forward",
      values: ["web"],
    });
    renderer.shutdown();
  });

  it("confirms selected entries from a multi-select's Submit row", async () => {
    const { input, renderer } = makeRenderer();
    const answer = renderer.setupFlow.readSelect({
      kind: "multi",
      message: "Select channels",
      options: [
        { value: "web", label: "Web Chat" },
        { value: "slack", label: "Slack" },
      ],
      required: true,
    });

    input.type(" ");
    input.down();
    input.down();
    input.enter();
    await expect(answer).resolves.toEqual(["web"]);
    renderer.shutdown();
  });

  it("reads text with validation errors painted in the panel", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.setupFlow.readText({
      message: "Project name",
      validate: (value) => (value.length < 3 ? "Too short." : undefined),
    });

    input.type("ab");
    input.enter();
    expect(screen.snapshot()).toContain("Too short.");

    input.type("c");
    input.enter();
    await expect(answer).resolves.toBe("abc");
    renderer.shutdown();
  });

  it("uses the default name as a placeholder when renaming the hovered row", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.setupFlow.readEditableSelect?.({
      message: "Vercel project",
      options: [
        { value: "new", label: "Create a new project", hint: "Name: weather-agent" },
        { value: "link", label: "Link an existing project" },
      ],
      initialValue: "new",
      editable: {
        value: "new",
        defaultValue: "weather-agent",
        formatHint: (value) => `Name: ${value}`,
      },
    });
    expect(answer).toBeDefined();

    // Hovering the editable row is already a live field — no → to enter.
    expect(screen.snapshot()).toContain("type to rename");
    expect(screen.snapshot()).toContain("Name: weather-agent");
    // The default is not real editor text, so backspace cannot partially erase
    // it. Typing replaces the placeholder with the new name.
    input.backspace();
    expect(screen.snapshot()).toContain("Name: weather-agent");
    input.type("weather-age!");
    expect(screen.snapshot()).toContain("Name: weather-age!");
    input.enter();
    await expect(answer).resolves.toEqual({
      kind: "edited",
      value: "new",
      text: "weather-age!",
    });
    renderer.shutdown();
  });

  it("returns an untouched editable row as a plain selection", async () => {
    const { input, renderer } = makeRenderer();

    const answer = renderer.setupFlow.readEditableSelect?.({
      message: "Vercel project",
      options: [
        { value: "new", label: "Create a new project", hint: "Name: weather-agent" },
        { value: "link", label: "Link an existing project" },
      ],
      initialValue: "new",
      editable: {
        value: "new",
        defaultValue: "weather-agent",
        formatHint: (value) => `Name: ${value}`,
      },
    });
    expect(answer).toBeDefined();

    input.enter();
    await expect(answer).resolves.toEqual({ kind: "selected", value: "new" });
    renderer.shutdown();
  });

  it("selects ChatGPT as a provider sibling", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.setupFlow.readProviderPicker({
      message: "Provider",
      options: [
        { value: "ai-gateway-project", label: "AI Gateway via Project" },
        { value: "ai-gateway-key", label: "AI Gateway via AI_GATEWAY_API_KEY" },
        { value: "chatgpt", label: "ChatGPT subscription" },
        { value: "external", label: "Other providers" },
      ],
      initialValue: "ai-gateway-project",
      validateInlineKey: async () => ({ kind: "valid" }),
    });

    expect(screen.snapshot()).toContain("ChatGPT subscription");
    input.down();
    input.down();
    input.enter();
    await expect(answer).resolves.toEqual({ kind: "chatgpt" });
    renderer.shutdown();
  });

  it("validates a masked key without replacing the provider frame", async () => {
    const { screen, input, renderer } = makeRenderer();
    let resolveValidation:
      | ((result: { kind: "valid" } | { kind: "invalid"; message: string }) => void)
      | undefined;
    const validate = vi.fn(
      () =>
        new Promise<{ kind: "valid" } | { kind: "invalid"; message: string }>((resolve) => {
          resolveValidation = resolve;
        }),
    );

    const answer = renderer.setupFlow.readProviderPicker({
      message: "Provider",
      options: [{ value: "ai-gateway-key", label: "AI Gateway via AI_GATEWAY_API_KEY" }],
      initialValue: "ai-gateway-key",
      validateInlineKey: validate,
    });

    expect(screen.rawOutput()).toContain("\x1b[7m");
    input.type("bad-key");
    input.enter();
    expect(screen.snapshot()).toContain("Provider");
    expect(screen.snapshot()).toContain("•••••••");
    expect(screen.snapshot()).not.toContain("bad-key");
    expect(screen.snapshot()).toContain("▪ validating");

    resolveValidation?.({ kind: "invalid", message: "Rejected." });
    await vi.waitFor(() => {
      expect(screen.snapshot()).toContain("API key is not valid");
    });
    input.type("x");
    expect(screen.snapshot()).not.toContain("API key is not valid");

    input.enter();
    resolveValidation?.({ kind: "valid" });
    await expect(answer).resolves.toEqual({
      kind: "ai-gateway-key",
      key: "bad-keyx",
      validation: { kind: "valid" },
    });
    expect(validate).toHaveBeenCalledTimes(2);
    renderer.shutdown();
  });

  it.each([
    { name: "Escape", sequence: "\x1b", waitForEscape: true },
    { name: "Ctrl-C", sequence: "\u0003", waitForEscape: false },
  ])(
    "clears a masked key before $name cancels its editable row",
    async ({ sequence, waitForEscape }) => {
      const { screen, input, renderer } = makeRenderer();
      const answer = renderer.setupFlow.readProviderPicker({
        message: "Provider",
        options: [{ value: "ai-gateway-key", label: "AI Gateway via AI_GATEWAY_API_KEY" }],
        initialValue: "ai-gateway-key",
        validateInlineKey: async () => ({ kind: "valid" }),
      });
      let settled = false;
      void answer.finally(() => {
        settled = true;
      });

      input.type("sk-secret");
      expect(screen.snapshot()).toContain("esc to clear");
      input.send(sequence);
      if (waitForEscape) await new Promise((resolve) => setTimeout(resolve, 50));

      expect(settled).toBe(false);
      expect(screen.snapshot()).not.toContain("•••••••••");
      expect(screen.snapshot()).toContain("type your key");
      expect(screen.snapshot()).toContain("esc to cancel");

      input.send(sequence);
      if (waitForEscape) await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(answer).resolves.toBeUndefined();
      renderer.shutdown();
    },
  );

  it("aborts stale validation and keeps the latest result", async () => {
    const { input, renderer } = makeRenderer();
    const validations: Array<{ key: string; signal: AbortSignal; finish(): void }> = [];
    const answer = renderer.setupFlow.readProviderPicker({
      message: "Provider",
      options: [{ value: "ai-gateway-key", label: "AI Gateway key" }],
      initialValue: "ai-gateway-key",
      validateInlineKey: (key, signal) => {
        return new Promise<{ kind: "valid" }>((resolve) => {
          validations.push({ key, signal, finish: () => resolve({ kind: "valid" }) });
        });
      },
    });

    input.type("sk-first");
    input.enter();
    await vi.waitFor(() => expect(validations).toHaveLength(1));
    input.send("\u0003");
    expect(validations[0]?.signal.aborted).toBe(true);
    input.type("sk-second");
    input.enter();
    await vi.waitFor(() => expect(validations).toHaveLength(2));

    validations[0]?.finish();
    await Promise.resolve();
    await Promise.resolve();
    validations[1]?.finish();
    await expect(answer).resolves.toEqual({
      kind: "ai-gateway-key",
      key: "sk-second",
      validation: { kind: "valid" },
    });
    renderer.shutdown();
  });

  it("drives the ephemeral flow status through the footer", () => {
    const { screen, renderer } = makeRenderer();

    renderer.renderNotice("anchor");
    renderer.setupFlow.setStatus("Checking the project…");
    expect(screen.snapshot()).toContain("Checking the project…");

    renderer.setupFlow.setStatus(undefined);
    expect(screen.snapshot()).not.toContain("Checking the project…");
    renderer.shutdown();
  });

  it("commits flow lines to the transcript with a shared marker", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.renderLine("Connected the agent to the Vercel AI Gateway.", "success");
    renderer.setupFlow.renderLine("visit https://vercel.com/connect", "info");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("* Connected the agent to the Vercel AI Gateway.");
    expect(snapshot).toContain("* visit https://vercel.com/connect");
  });
});

describe("TerminalRenderer setup flow session", () => {
  it("repaints multiline setup titles without leaking copies into the transcript", async () => {
    const { screen, input, renderer } = makeRenderer();
    const message =
      "You need to link to a project to use linear through Vercel Connect.\n\nSelect your team";

    renderer.setupFlow.begin("Add to your agent");
    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      message,
      options: [
        { value: "vercel", label: "Vercel" },
        { value: "labs", label: "Vercel Labs" },
      ],
    });
    input.down();
    input.up();

    expect(screen.snapshot().split(message.split("\n")[0]!)).toHaveLength(2);
    input.send("\x1b");
    await expect(answer).resolves.toBeUndefined();
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.shutdown();
  });

  it("discards inherited subprocess output when restoring the transcript", async () => {
    const { screen, input, renderer } = makeRenderer();

    renderer.renderNotice("anchor");
    renderer.setupFlow.begin("Add integration");
    let inherited = false;
    await renderer.setupFlow.withInheritedStdio(async () => {
      inherited = true;
      input.pause();
      screen.write("temporary OAuth instructions\n");
      expect(screen.snapshot()).toContain("temporary OAuth instructions");
    });

    expect(inherited).toBe(true);
    expect(input.resumeCalls).toBe(2);
    expect(screen.snapshot()).toContain("anchor");
    expect(screen.snapshot()).not.toContain("┃ Add integration");
    expect(screen.snapshot()).not.toContain("temporary OAuth instructions");
    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("discards input without interrupting a non-interruptible flow", async () => {
    const { input, renderer } = makeRenderer();
    renderer.setupFlow.begin("Add to your agent");
    const interrupt = renderer.setupFlow.waitForInterrupt({ interruptible: false });
    let interrupted = false;
    void interrupt.promise.then(() => {
      interrupted = true;
    });

    input.send("hello\x1b\r");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(interrupted).toBe(false);
    interrupt.dispose();
    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("uses the build-phase pulse for pulse setup flows", () => {
    vi.useFakeTimers();
    try {
      const { screen, renderer } = makeRenderer();

      renderer.setupFlow.begin("Configure the agent model");
      renderer.setupFlow.setStatus("Checking the project…");
      expect(screen.snapshot()).toContain("▪ Checking the project…");

      vi.advanceTimersByTime(450);
      expect(screen.snapshot()).not.toContain("▪ Checking the project…");
      expect(screen.snapshot()).toContain("  Checking the project…");
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows elapsed time after a setup status has run for five seconds", () => {
    vi.useFakeTimers();
    try {
      const { screen, renderer } = makeRenderer();

      renderer.setupFlow.begin("Add to your agent");
      renderer.setupFlow.setStatus("Installing Slack and dependencies…");
      expect(screen.snapshot()).not.toContain("5s");

      vi.advanceTimersByTime(5_100);
      expect(screen.snapshot()).toContain("Installing Slack and dependencies… 5s");
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a browser wait on the green pulse without highlighting its text", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("Agent connections");
    renderer.setupFlow.setStatus("Finish signing in to Vercel in your browser");

    expect(screen.rawOutput()).toContain("\x1b[32m▪\x1b[39m");
    expect(screen.rawOutput()).toContain("\x1b[2mFinish signing in to Vercel in your browser");
    expect(screen.rawOutput()).not.toContain("\x1b[33m");
    renderer.shutdown();
  });

  it("uses an ASCII fallback for pulse setup flows", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: false,
    });

    renderer.setupFlow.begin("Configure the agent model");
    renderer.setupFlow.setStatus("Checking the project...");

    expect(screen.snapshot()).toContain("* Checking the project...");
    expect(screen.snapshot()).not.toContain("▪");
    renderer.shutdown();
  });

  it("holds flow output inside the panel and clears it on end, flushing warnings", () => {
    const { screen, renderer } = makeRenderer();

    renderer.renderNotice("anchor");
    renderer.setupFlow.begin("/deploy");
    renderer.setupFlow.renderLine("Creating Vercel project…", "info");
    renderer.setupFlow.renderLine("Finish attach with `vercel connect attach`.", "warning");
    renderer.setupFlow.setStatus("Loading teams…");

    let snapshot = screen.snapshot();
    expect(snapshot).not.toContain("┃ /deploy");
    expect(snapshot).toContain("Creating Vercel project…");
    expect(snapshot).toContain("Loading teams…");

    renderer.setupFlow.end();
    renderer.shutdown();

    snapshot = screen.snapshot();
    // Ephemeral content vanished with the panel…
    expect(snapshot).not.toContain("Creating Vercel project…");
    expect(snapshot).not.toContain("Loading teams…");
    // …while the actionable warning flushed to the transcript.
    expect(snapshot).toContain("Finish attach with `vercel connect attach`.");
  });

  it("discards superseded warnings when a successful /deploy result replaces the panel", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    renderer.setupFlow.renderLine("Project name unavailable", "warning");
    renderer.setupFlow.renderLine(
      'Vercel project "weather-agent" already exists. Choose a different project name.',
      "warning",
    );
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.finishCommand({
      kind: "result",
      message: "Project linked. Connected to AI Gateway via VERCEL_OIDC_TOKEN.",
    });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("Project name unavailable");
    expect(snapshot).not.toContain("already exists");
    expect(snapshot).toContain("Project linked. Connected to AI Gateway via VERCEL_OIDC_TOKEN.");
  });

  it("gives the active question the flow heading", async () => {
    const { screen, input, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    renderer.setupFlow.renderLine("This directory is not linked yet.", "info");
    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      message: "Vercel project",
      options: [{ value: "new", label: "Create a new project" }],
    });

    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("┃ /deploy");
    expect(snapshot).toContain("Vercel project");
    expect(snapshot).toMatch(/─{20,}/);
    expect(snapshot).toContain("This directory is not linked yet.");
    expect(snapshot).toContain("Vercel project");

    input.enter();
    await expect(answer).resolves.toEqual(["new"]);
    renderer.setupFlow.end();
    renderer.shutdown();
    expect(screen.snapshot()).not.toContain("Vercel project");
  });

  it("renders only the latest task outcome below a task-list question", async () => {
    const { screen, input, renderer } = makeRenderer();
    const options = [
      {
        value: "repl",
        label: "Terminal UI",
        completed: true,
        focusHint: "Already installed",
      },
      {
        value: "web",
        label: "Web Chat",
        completed: true,
        focusHint: "Already installed",
      },
      { value: "slack", label: "Slack", hint: "Creates slackbot and deploys to Vercel" },
      { value: "done", label: "Done", trailingAction: true },
    ];

    renderer.setupFlow.begin("Agent channels");
    const first = renderer.setupFlow.readSelect({
      kind: "task-list",
      message: "Where will you chat with your agent?",
      options,
    });
    input.down();
    input.down();
    input.enter();
    await expect(first).resolves.toEqual(["slack"]);

    renderer.setupFlow.renderLine(
      "Slack channel was not added because Slackbot setup was skipped.",
      "warning",
    );
    const second = renderer.setupFlow.readSelect({
      kind: "search",
      layout: "task-list",
      message: "Where will you chat with your agent?",
      options,
    });
    input.down();
    input.down();
    input.enter();
    await expect(second).resolves.toEqual(["slack"]);

    renderer.setupFlow.renderLine("Scaffolding Web Chat channel files...", "info");
    renderer.setupFlow.renderLine("Overwrote /tmp/weather-agent", "warning");
    renderer.setupFlow.renderLine("Scaffolded channel: web", "success");
    renderer.setupFlow.renderLine("Dependency installation failed.", "error");
    const third = renderer.setupFlow.readSelect({
      kind: "task-list",
      message: "Where will you chat with your agent?",
      options,
    });

    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("Slack channel was not added");
    expect(snapshot).not.toContain("Scaffolding Web Chat channel files");
    // A focused completed row retains a dim inert cursor; resting completed
    // rows retain their semantic check without borrowing selection weight.
    expect(snapshot).toContain("› Terminal UI · Already installed");
    expect(snapshot).toContain("✓ Web Chat");
    expect(snapshot).toContain("Slack       · Creates slackbot and deploys to Vercel");
    expect(snapshot).toContain("Dependency installation failed.");

    input.send("\x1b");
    await expect(third).resolves.toBeUndefined();
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.shutdown();
  });

  it("replaces setup lines with a compact current-item summary", async () => {
    const { screen, input, renderer } = makeRenderer();

    renderer.setupFlow.begin("Add to your agent");
    renderer.setupFlow.renderLine("Scaffolded channel: photon", "success");
    renderer.setupFlow.renderLine("Photon project: https://app.photon.codes", "success");
    renderer.setupFlow.replaceContent?.({
      headline: "Scaffolded channel/photon-imessage",
      facts: [
        { label: "Agent phone number", value: "+15551234567" },
        { label: "Photon project dashboard", value: "https://app.photon.codes" },
      ],
    });
    const answer = renderer.setupFlow.readSelect({
      kind: "task-list",
      message: "What would you like to do next?",
      options: [
        { value: "add-more", label: "Add more" },
        { value: "finish", label: "Finish", trailingAction: true },
      ],
    });

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("Scaffolded channel/photon-imessage");
    expect(snapshot).toContain("Agent phone number: +15551234567");
    expect(snapshot).toContain("Photon project dashboard: https://app.photon.codes");
    expect(snapshot).not.toContain("Scaffolded channel: photon");
    expect(snapshot).not.toContain("Photon project: https://app.photon.codes");

    input.enter();
    await expect(answer).resolves.toEqual(["add-more"]);
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.shutdown();
  });

  it("clears the completed item and install status before the batch follow-up", async () => {
    const { screen, input, renderer } = makeRenderer();

    renderer.setupFlow.begin("Set up your agent");
    renderer.setupFlow.replaceContent?.({ headline: "Adding GitHub · 2 of 3", facts: [] });
    renderer.setupFlow.setStatus("Installing files and dependencies…");
    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      message: "What would you like to do next?",
      options: [
        { value: "deploy", label: "Deploy" },
        { value: "finish", label: "Start chatting" },
      ],
    });

    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("Adding GitHub · 2 of 3");
    expect(snapshot).not.toContain("Installing files and dependencies");
    expect(snapshot).toContain("What would you like to do next?");

    input.enter();
    await expect(answer).resolves.toEqual(["deploy"]);
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.shutdown();
  });

  it("keeps enter on a completed setup row as a no-op", async () => {
    const { input, renderer } = makeRenderer();
    const answer = renderer.setupFlow.readSelect({
      kind: "task-list",
      message: "Where will you chat with your agent?",
      options: [
        {
          value: "web",
          label: "Web Chat",
          completed: true,
          focusHint: "Already installed",
        },
        { value: "done", label: "Done", trailingAction: true },
      ],
    });
    let settled = false;
    void answer.then(() => {
      settled = true;
    });

    input.enter();
    await Promise.resolve();
    expect(settled).toBe(false);

    input.down();
    input.enter();
    await expect(answer).resolves.toEqual(["done"]);
    renderer.shutdown();
  });

  it("does not select a concurrent action until navigation enters the action group", async () => {
    const { screen, input, renderer } = makeRenderer();

    renderer.setupFlow.begin("Agent channels");
    const prompt = renderer.setupFlow.readChoice({
      status: "Creating a Slackbot through Vercel Connect...",
      context: "Waiting for you to complete setup in the browser",
      actions: [
        { value: "retry", label: "Try again" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    let settled = false;
    void prompt.choice.then(() => {
      settled = true;
    });

    expect(screen.snapshot()).toContain("Waiting for you to complete setup in the browser");
    input.enter();
    await Promise.resolve();
    expect(settled).toBe(false);

    input.down();
    input.enter();
    await expect(prompt.choice).resolves.toBe("retry");

    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("fires the armed interrupt on Ctrl-C while the flow is working (no question open)", async () => {
    const { input, renderer } = makeRenderer();

    renderer.setupFlow.begin("Agent channels");
    const interrupt = renderer.setupFlow.waitForInterrupt();
    renderer.setupFlow.setStatus("Creating a Slackbot through Vercel Connect...");

    input.ctrlC();
    await expect(interrupt.promise).resolves.toBe("ctrl-c");

    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("lets an open question keep its keys, then re-arms the trap when it closes", async () => {
    const { input, renderer } = makeRenderer();

    renderer.setupFlow.begin("Agent channels");
    const interrupt = renderer.setupFlow.waitForInterrupt();
    let fired = false;
    void interrupt.promise.then(() => {
      fired = true;
    });

    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      message: "Where will you chat with your agent?",
      options: [{ value: "web", label: "Web Chat" }],
    });

    // Ctrl-C cancels the question, not the flow.
    input.ctrlC();
    await expect(answer).resolves.toBeUndefined();
    expect(fired).toBe(false);

    // Back in the working state, the trap is re-armed.
    renderer.setupFlow.setStatus("Creating a Slackbot through Vercel Connect...");
    input.ctrlC();
    await interrupt.promise;

    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("drops flow keys once the interrupt trap is disposed", async () => {
    const { input, renderer } = makeRenderer();

    renderer.setupFlow.begin("Agent channels");
    const interrupt = renderer.setupFlow.waitForInterrupt();
    let fired = false;
    void interrupt.promise.then(() => {
      fired = true;
    });

    interrupt.dispose();
    input.ctrlC();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fired).toBe(false);

    renderer.setupFlow.end();
    renderer.shutdown();
  });
});

describe("TerminalRenderer setup select typing", () => {
  it("ignores digits when a static select is not searchable", async () => {
    const { input, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      message: "Vercel project",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
    });

    input.type("3");
    input.enter();
    await expect(answer).resolves.toEqual(["a"]);
    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("appends a search action after matching options", async () => {
    const { screen, input, renderer } = makeRenderer();

    renderer.setupFlow.begin("/model");
    const answer = renderer.setupFlow.readSelect({
      kind: "search",
      message: "Project to link",
      options: [{ value: "prj_veto", label: "veto" }],
      searchAction: { label: (query) => `Search for '${query}'` },
    });

    input.type("v");
    expect(screen.snapshot()).toContain("veto");
    expect(screen.snapshot()).toContain("Search for 'v'");
    input.down();
    input.enter();
    await expect(answer).resolves.toEqual([searchActionValue("v")]);

    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("keeps the searchable panel open while a search action loads results", async () => {
    const { screen, input, renderer } = makeRenderer();
    let resolveSearch!: (options: readonly { value: string; label: string }[]) => void;
    const search = vi.fn(
      () =>
        new Promise<readonly { value: string; label: string }[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );

    renderer.setupFlow.begin("/model");
    const answer = renderer.setupFlow.readSelect({
      kind: "search",
      message: "Project to link",
      options: [{ value: "prj_recent", label: "recent-agent" }],
      searchAction: { label: (query) => `Search for '${query}'`, load: search },
    });

    input.type("older-agent");
    input.enter();

    expect(search).toHaveBeenCalledWith("older-agent");
    expect(screen.snapshot()).toMatch(/older-agent▏ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(screen.snapshot()).toContain("Project to link");

    resolveSearch([
      { value: "prj_recent", label: "recent-agent" },
      { value: "prj_older", label: "older-agent" },
    ]);
    await vi.waitFor(() => expect(screen.snapshot()).toContain("Search for 'older-agent'"));
    for (const _ of "older-agent") input.backspace();
    expect(screen.snapshot()).toContain("recent-agent");
    expect(screen.snapshot()).toContain("older-agent");

    input.type("older-agent");
    await vi.waitFor(() => expect(screen.snapshot()).toContain("older-agent▏"));
    input.send("\x1b");
    await vi.waitFor(() => {
      expect(screen.snapshot()).toContain("recent-agent");
      expect(screen.snapshot()).toContain("older-agent");
    });
    input.down();
    input.enter();
    await expect(answer).resolves.toEqual(["prj_older"]);

    renderer.setupFlow.end();
    renderer.shutdown();
  });
});

describe("TerminalRenderer flow output preview", () => {
  it("shows only the latest subprocess line and never persists it", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    renderer.setupFlow.renderOutput("> Downloading `development` Environment Variables");
    renderer.setupFlow.renderOutput("+ VERCEL_OIDC_TOKEN (Updated)");

    let snapshot = screen.snapshot();
    expect(snapshot).toContain("+ VERCEL_OIDC_TOKEN (Updated)");
    expect(snapshot).not.toContain("> Downloading");

    renderer.setupFlow.renderLine("Connected the agent to the Vercel AI Gateway.", "success");
    snapshot = screen.snapshot();
    expect(snapshot).not.toContain("+ VERCEL_OIDC_TOKEN (Updated)");

    renderer.setupFlow.end();
    renderer.shutdown();
    expect(screen.snapshot()).not.toContain("VERCEL_OIDC_TOKEN");
  });

  it("pulls buffered output in as context when a warning settles it", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    renderer.setupFlow.renderOutput("Error: build failed in step X");
    renderer.setupFlow.renderLine("`vercel deploy --prod` failed.", "warning");

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("Error: build failed in step X");
    expect(snapshot).toContain("`vercel deploy --prod` failed.");
    renderer.setupFlow.end();
    renderer.shutdown();
  });

  it("keeps an error's pulled-in output past the panel close, above its diagnostic", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    renderer.setupFlow.renderLine("Deploying the agent to Vercel production...", "info");
    renderer.setupFlow.renderOutput("Error: missing project settings");
    renderer.setupFlow.renderOutput("Learn more: https://vercel.link/x");
    renderer.setupFlow.renderLine("`vercel deploy --prod` failed.", "error");
    renderer.setupFlow.end();
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // Plain progress vanished with the panel…
    expect(snapshot).not.toContain("Deploying the agent to Vercel production...");
    // …while the failure kept its evidence, ordered above the diagnostic.
    const evidenceIndex = snapshot.indexOf("Error: missing project settings");
    const diagnosticIndex = snapshot.indexOf("`vercel deploy --prod` failed.");
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(snapshot).toContain("Learn more: https://vercel.link/x");
    expect(diagnosticIndex).toBeGreaterThan(evidenceIndex);
  });

  it("drops pulled-in output with the diagnostics when the close discards them", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    renderer.setupFlow.renderOutput("Error: missing project settings");
    renderer.setupFlow.renderLine("`vercel deploy --prod` failed.", "error");
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("Error: missing project settings");
    expect(snapshot).not.toContain("`vercel deploy --prod` failed.");
  });

  it("keeps only the freshest buffered output lines when a failure settles a long transcript", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    for (let index = 1; index <= 45; index += 1) {
      renderer.setupFlow.renderOutput(`build step ${String(index).padStart(2, "0")}`);
    }
    renderer.setupFlow.renderLine("`vercel deploy --prod` failed.", "error");
    renderer.setupFlow.end();
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // 45 lines through a 40-line buffer: the head fell off, the tail survives.
    expect(snapshot).not.toContain("build step 05");
    expect(snapshot).toContain("build step 06");
    expect(snapshot).toContain("build step 45");
  });

  it("keeps a live pulse when the flow is between phases", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    expect(screen.snapshot()).toContain("Working…");
    renderer.setupFlow.end();
    renderer.shutdown();
  });
});

describe("TerminalRenderer command echo spacing", () => {
  it("gives the echoed command the same air as a user message, with the result tight under it", async () => {
    const { screen, input, renderer } = makeRenderer();

    renderer.renderNotice("assistant said something");
    const prompt = readPrompt(renderer);
    input.type("/info");
    input.enter();
    await prompt;
    renderer.finishCommand({ kind: "result", message: "Project linked." });
    renderer.shutdown();

    const lines = screen.snapshot().split("\n");
    const echoIndex = lines.findIndex((line) => line.includes("/info"));
    expect(echoIndex).toBeGreaterThan(0);
    expect(lines[echoIndex - 1]).toBe("");
    const resultIndex = lines.findIndex((line) => line.includes("⎿  Project linked."));
    expect(resultIndex).toBe(echoIndex + 1);
  });
});

describe("TerminalRenderer command typeahead", () => {
  it("offers command suggestions while the draft is a lone slash token", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("/");
    const snapshot = screen.snapshot();
    expect(snapshot).toContain("/help");
    expect(snapshot).toContain("Show available commands");
    expect(snapshot).toContain("Choose a model, speed, and reasoning");
    const promptLine = snapshot.split("\n").find((line) => line.includes("│ /"));
    expect(promptLine?.startsWith("│ /")).toBe(true);

    input.enter();
    // The highlighted default — /model leads the registry — is what a bare
    // slash submits.
    expect(await prompt).toBe("/model");
    renderer.shutdown();
  });

  it("collapses a complete command into an inline argument hint", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("/model");
    const snapshot = screen.snapshot();
    // The prompt row carries the dim argument shape inline (the caret sits
    // between the typed name and the hint)...
    expect(snapshot).toContain("/model");
    expect(snapshot).toContain("[provider/model]");
    // ...and the dropdown (with its description column) is gone.
    expect(snapshot).not.toContain("Choose a model, speed, and reasoning");

    input.enter();
    expect(await prompt).toBe("/model");
    renderer.shutdown();
  });

  it("delays loading until model argument suggestions remain pending", async () => {
    vi.useFakeTimers();
    try {
      const screen = new MockScreen({ columns: 80, rows: 30 });
      const input = new MockUserInput();
      const suggestions = Promise.withResolvers<
        readonly {
          value: string;
          label: string;
          hint?: string;
        }[]
      >();
      const renderer = new TerminalRenderer({
        input,
        output: screen,
        captureForeignOutput: false,
        unicode: true,
        argumentSuggestions: async () => suggestions.promise,
      });

      const prompt = readPrompt(renderer);
      input.type("/model ");
      expect(screen.snapshot()).not.toContain("Loading models…");

      await vi.advanceTimersByTimeAsync(500);
      expect(screen.snapshot()).toContain("Loading models…");

      suggestions.resolve([{ value: "openai/gpt-5", label: "GPT-5" }]);
      await vi.waitFor(() => expect(screen.snapshot()).toContain("openai/gpt-5"));
      input.enter();
      await prompt;
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not paint loading when argument suggestions resolve within the delay", async () => {
    vi.useFakeTimers();
    try {
      const screen = new MockScreen({ columns: 80, rows: 30 });
      const input = new MockUserInput();
      const renderer = new TerminalRenderer({
        input,
        output: screen,
        captureForeignOutput: false,
        unicode: true,
        argumentSuggestions: async () => [{ value: "openai/gpt-5", label: "GPT-5" }],
      });

      const prompt = readPrompt(renderer);
      input.type("/model ");
      await vi.advanceTimersByTimeAsync(499);
      expect(screen.snapshot()).toContain("openai/gpt-5");
      expect(screen.snapshot()).not.toContain("Loading models…");
      input.enter();
      await prompt;
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances to reasoning after selecting a model with reasoning choices", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      argumentSuggestions: async () => [
        {
          value: "openai/gpt-6-sol",
          label: "openai/gpt-6-sol",
          next: [{ value: "high", label: "high" }],
        },
      ],
    });

    const prompt = readPrompt(renderer);
    input.type("/model sol");
    await vi.waitFor(() => expect(screen.snapshot()).toContain("openai/gpt-6-sol"));
    input.enter();
    expect(screen.snapshot()).toContain("│ /model openai/gpt-6-sol ");
    expect(screen.snapshot()).toContain("high");
    input.enter();

    expect(await prompt).toBe("/model openai/gpt-6-sol high");
    renderer.shutdown();
  });

  it("completes a model argument from its inline catalog", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      argumentSuggestions: async (command) =>
        command === "model"
          ? [
              {
                value: "anthropic/claude-sonnet-5",
                label: "Claude Sonnet 5",
                hint: "Anthropic",
              },
            ]
          : [],
    });

    const prompt = readPrompt(renderer);
    input.type("/model claude");
    await vi.waitFor(() => expect(screen.snapshot()).toContain("anthropic/claude-sonnet-5"));
    input.enter();

    expect(await prompt).toBe("/model anthropic/claude-sonnet-5");
    renderer.shutdown();
  });

  it("completes an add argument from its inline registry catalog", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      argumentSuggestions: async (command) =>
        command === "add"
          ? [{ value: "channel/slack", label: "Slack", hint: "Slack channel" }]
          : [],
    });

    const prompt = readPrompt(renderer);
    input.type("/add slack");
    await vi.waitFor(() => expect(screen.snapshot()).toContain("channel/slack"));
    input.send("\t");
    input.enter();

    expect(await prompt).toBe("/add channel/slack");
    renderer.shutdown();
  });

  it("tab completes the highlighted command without submitting", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("/mo");
    input.send("\t");
    input.type("anthropic/claude-opus-4.8");
    input.enter();
    // Tab left "/model " in the editor; typing continued in argument position.
    expect(await prompt).toBe("/model anthropic/claude-opus-4.8");
    renderer.shutdown();
  });

  it("enter completes and submits the highlighted command from a prefix", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("/ad");
    input.enter();
    expect(await prompt).toBe("/add");
    renderer.shutdown();

    expect(screen.snapshot()).toContain("│ /add");
    expect(screen.snapshot()).not.toContain("❯ /add");
  });

  it("submits an alias as typed instead of canonicalizing it", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("/quit");
    input.enter();
    expect(await prompt).toBe("/quit");
    renderer.shutdown();

    expect(screen.snapshot()).toContain("│ /quit");
  });

  it("keeps a submitted /help invocation above its transient drawer", async () => {
    const { input, renderer, screen } = makeRenderer();
    const prompt = readPrompt(renderer);
    input.type("/help");
    input.enter();
    expect(await prompt).toBe("/help");

    const choice = renderer.choosePromptCommand(PROMPT_COMMANDS);
    const open = screen.snapshot().split("\n");
    expect(open.filter((line) => line.startsWith("│ /help"))).toEqual(["│ /help"]);
    expect(open.indexOf("│ /help")).toBeLessThan(open.findIndex((line) => /^─{20,}$/.test(line)));
    input.send("\x1b");
    expect(await choice).toBeUndefined();
    expect(screen.snapshot()).not.toContain("Show available commands");
    expect(screen.snapshot()).not.toContain("│ /help");
    renderer.renderCommandInvocation("/model anthropic/claude-opus-4.8");
    renderer.finishCommand({
      kind: "result",
      message: "",
      summary: "Model set to anthropic/claude-opus-4.8",
    });
    renderer.shutdown();
    expect(screen.snapshot()).toContain("Model set to anthropic/claude-opus-4.8");
    expect(screen.snapshot()).not.toContain("/help");
  });

  it("lets /help choose a command without retaining the drawer", async () => {
    const { input, renderer, screen } = makeRenderer();
    const choice = renderer.choosePromptCommand(PROMPT_COMMANDS);

    const open = screen.snapshot();
    expect(open).not.toContain("┃ Commands");
    expect(open).toContain("/model");
    expect(open).toContain("↑/↓ move · Enter select · Esc close");
    expect(open.match(/─{20,}/g)).toHaveLength(2);
    expect(open).not.toMatch(/\b1\. \/model/);
    input.down();
    input.enter();
    expect(await choice).toBe("/reset");
    expect(screen.snapshot()).not.toContain("Choose a model, speed, and reasoning");
    renderer.shutdown();
  });

  it("restores a help selection as a command-gutter composer with argument suggestions", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      argumentSuggestions: async () => [{ value: "openai/gpt-5", label: "GPT-5" }],
    });
    const help = renderer.choosePromptCommand(PROMPT_COMMANDS);
    input.enter();
    const selection = await help;
    expect(selection).toBe("/model ");
    const prompt = readPrompt(renderer, { initialDraft: selection });
    await vi.waitFor(() => expect(screen.snapshot()).toContain("openai/gpt-5"));
    expect(screen.snapshot()).toContain("│ /model");
    expect(screen.snapshot()).not.toContain("❯ /model");
    input.enter();
    expect(await prompt).toBe("/model openai/gpt-5");
    renderer.shutdown();
  });

  it("keeps the selected help command visible on short terminals", async () => {
    const { input, renderer, screen } = makeRenderer(80, 10);
    const choice = renderer.choosePromptCommand(PROMPT_COMMANDS);
    for (let i = 0; i < 8; i += 1) input.down();
    expect(screen.snapshot()).toContain("/traces");
    expect(screen.snapshot()).not.toContain("┃ Commands");
    input.enter();
    expect(await choice).toBe("/traces ");
    renderer.shutdown();
  });

  it("keeps a submitted /info invocation above its transient drawer", async () => {
    const { input, renderer, screen } = makeRenderer();
    const prompt = readPrompt(renderer);
    input.type("/info");
    input.enter();
    expect(await prompt).toBe("/info");

    const panel = renderer.showInfoPanel("Application");
    const open = screen.snapshot().split("\n");
    expect(open.filter((line) => line.includes("/info"))).toEqual(["│ /info"]);
    expect(open.indexOf("│ /info")).toBeLessThan(open.findIndex((line) => /^─{20,}$/.test(line)));
    input.send("\x1b");
    await panel;
    expect(screen.snapshot()).not.toContain("Application");
    expect(screen.snapshot()).not.toContain("│ /info");
    renderer.renderCommandInvocation("/model anthropic/claude-opus-4.8");
    renderer.finishCommand({
      kind: "result",
      message: "",
      summary: "Model set to anthropic/claude-opus-4.8",
    });
    renderer.shutdown();
    expect(screen.snapshot()).toContain("Model set to anthropic/claude-opus-4.8");
    expect(screen.snapshot()).not.toContain("/info");
  });

  it("closes the transient info panel without retaining its contents", async () => {
    const { input, renderer, screen } = makeRenderer();
    const panel = renderer.showInfoPanel(
      "\x1b[36mApplication\x1b[39m\n\x1b[1mAgent\x1b[22m: Weather",
    );

    const open = screen.snapshot();
    expect(open).not.toContain("┃ Application info");
    expect(open).toContain("Application");
    expect(open).toContain("Agent: Weather");
    expect(open).toContain("Esc to close");
    expect(open.match(/─{20,}/g)).toHaveLength(2);
    expect(open).not.toContain("[36m");
    input.send("\x1b");
    await panel;
    expect(screen.snapshot()).not.toContain("Application");
    expect(screen.snapshot()).not.toContain("Agent: Weather");
    renderer.shutdown();
  });

  it("scrolls long info drawers within the terminal before closing", async () => {
    const { input, renderer, screen } = makeRenderer(60, 10);
    const panel = renderer.showInfoPanel(
      Array.from({ length: 12 }, (_, i) => `Entry ${i}`).join("\n"),
    );
    expect(screen.snapshot()).toContain("Entry 0");
    expect(screen.snapshot()).toContain("↑/↓ scroll · Esc close");
    for (let i = 0; i < 10; i += 1) input.down();
    expect(screen.snapshot()).toContain("Entry 11");
    expect(screen.snapshot()).not.toContain("Entry 0");
    input.send("\x1b");
    await panel;
    expect(screen.snapshot()).not.toContain("Entry 11");
    renderer.shutdown();
  });

  it("resolves an open transient drawer on shutdown", async () => {
    const { renderer } = makeRenderer();
    const choice = renderer.choosePromptCommand(PROMPT_COMMANDS);
    renderer.shutdown();
    expect(await choice).toBeUndefined();
  });

  it("moves the suggestion highlight with arrows instead of recalling history", async () => {
    const { input, renderer } = makeRenderer();

    const first = readPrompt(renderer);
    input.type("an earlier prompt");
    input.enter();
    await first;

    const second = readPrompt(renderer);
    input.type("/");
    input.down();
    input.enter();
    // Down moved /model → /reset; history recall would have submitted the
    // earlier prompt instead.
    expect(await second).toBe("/reset");
    renderer.shutdown();
  });

  it("leaves transient commands and setup drawers out of prompt history", async () => {
    const { input, renderer } = makeRenderer();

    for (const text of [
      "an earlier prompt",
      "/model anthropic/claude-opus-4.6 default",
      "/help",
      "/info",
      "/add connection/linear",
      "/login chatgpt",
      "/loglevel all",
      "/traces",
    ]) {
      const prompt = readPrompt(renderer);
      input.type(text);
      input.enter();
      await prompt;
    }

    const recalled = readPrompt(renderer);
    input.up();
    input.enter();
    expect(await recalled).toBe("an earlier prompt");
    renderer.shutdown();
  });

  it("escape dismisses the suggestions until the draft changes", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = readPrompt(renderer);
    input.type("/");
    expect(screen.snapshot()).toContain("Show available commands");

    input.send("\x1b");
    // A lone ESC is held ~30ms before it flushes as a key.
    await vi.waitFor(() => {
      expect(screen.snapshot()).not.toContain("Show available commands");
    });

    input.type("m");
    expect(screen.snapshot()).toContain("Choose a model, speed, and reasoning");
    input.enter();
    expect(await prompt).toBe("/model");
    renderer.shutdown();
  });

  it("keeps suggestions away from question text input", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Anything else?",
      display: "text",
    });
    input.type("/");
    expect(screen.snapshot()).not.toContain("Show available commands");
    input.enter();
    await answer;
    renderer.shutdown();
  });

  it("uses the target-specific command list for typeahead", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      availablePromptCommands: promptCommandsFor("remote"),
    });

    const prompt = readPrompt(renderer);
    input.type("/");
    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("Authenticate with Vercel");
    expect(snapshot).not.toContain("Choose a model, speed, and reasoning");
    input.enter();
    await prompt;
    renderer.shutdown();
  });

  it("echoes a known unavailable command as a command, not chat", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      availablePromptCommands: promptCommandsFor("remote"),
    });

    const prompt = readPrompt(renderer);
    input.type("/model");
    input.enter();

    await expect(prompt).resolves.toBe("/model");
    renderer.shutdown();
    expect(screen.snapshot()).toContain("│ /model");
    expect(screen.snapshot()).not.toContain("❯ /model");
  });
});

describe("TerminalRenderer status line", () => {
  const vercelStatus = {
    identity: { projectName: "my-agent", teamName: "acme" },
  };

  it("renders the model and Vercel link without the local port under the prompt row", async () => {
    const { screen, input, renderer } = makeRenderer();
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("anthropic/claude-sonnet-5", {
        kind: "gateway",
        connected: false,
      }),
    });

    const prompt = readPrompt(renderer);
    renderer.setVercelStatus(vercelStatus);

    expect(screen.snapshot()).toContain("⚠ ai-gateway");

    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("anthropic/claude-sonnet-5", {
        kind: "gateway",
        connected: true,
        credential: "oidc",
      }),
    });

    const lines = screen.snapshot().split("\n");
    const promptRow = lines.findIndex((line) => line.includes("❯"));
    expect(promptRow).toBeGreaterThan(-1);
    const statusRow = lines.slice(promptRow + 1).join("\n");
    expect(statusRow).not.toContain(":3000");
    expect(statusRow).toContain("anthropic/claude-sonnet-5");
    // The linked project folds into the connected gateway label.
    expect(statusRow).toContain("· ai-gateway(oidc:my-agent)");
    expect(statusRow).not.toContain("⚠ ai-gateway");
    // No token segment before any turn reports usage (↑ 0 ↓ 0 is noise).
    expect(statusRow).not.toContain("↑ 0");
    expect(statusRow).not.toContain("/deploy pending");

    // An empty Enter is inert; the reader needs content to settle.
    input.type("done");
    input.enter();
    await prompt;
    renderer.shutdown();
  });

  it("suppresses the status line while a setup flow panel is open", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderNotice("anchor");
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("anthropic/claude-sonnet-5", {
        kind: "gateway",
        connected: true,
        credential: "oidc",
      }),
    });
    renderer.setVercelStatus(vercelStatus);
    expect(screen.snapshot()).toContain("· ai-gateway(oidc:my-agent)");

    renderer.setupFlow.begin("Connect to Vercel");
    expect(screen.snapshot()).not.toContain("· ai-gateway(oidc:my-agent)");

    renderer.setupFlow.end({ preserveDiagnostics: false });
    expect(screen.snapshot()).toContain("· ai-gateway(oidc:my-agent)");
    renderer.shutdown();
  });

  it("lays out the remote authentication panel and inset status line", async () => {
    const { screen, input, renderer } = makeRenderer(100, 40);
    renderer.renderNotice("anchor");
    renderer.setRemoteConnectionStatus({
      target: {
        kind: "remote",
        serverUrl: "https://vpoke.playground-vercel.tools",
        workspaceRoot: "/tmp/weather-agent",
      },
      connection: {
        state: "authenticating",
        challenge: { kind: "eve-oidc" },
      },
    });

    renderer.setupFlow.begin("Authenticate via Vercel OIDC");
    const answer = renderer.setupFlow.readSelect({
      kind: "search",
      message: "Select your team",
      placeholder: "type to search teams",
      options: [
        { value: "vercel", label: "Vercel" },
        { value: "labs", label: "Vercel Labs" },
      ],
    });

    const lines = screen.snapshot().split("\n");
    const title = lines.indexOf("   Select your team");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(lines).not.toContain("   Authenticate via Vercel OIDC");
    const status = lines.indexOf("   ↗ vpoke.playground-vercel.tools  Authenticating via OIDC…");
    expect(status).toBeGreaterThan(title);
    expect(lines[status - 1]).toBe("");

    input.send("\x1b");
    await expect(answer).resolves.toBeUndefined();
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.shutdown();
  });

  it("renders the reasoning level and fast marker on the model segment", () => {
    const { screen, renderer } = makeRenderer(100);
    renderer.renderNotice("anchor");
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel(
        "xai/grok-4.5",
        { kind: "gateway", connected: true, credential: "oidc" },
        {
          reasoning: "xhigh",
          providerOptions: { gateway: { serviceTier: "priority" } },
        },
      ),
    });
    // The first header commits with no footer; a Vercel status probe is the
    // paint that reveals the persistent status line beneath it.
    renderer.setVercelStatus(vercelStatus);

    expect(screen.snapshot()).toContain("xai/grok-4.5@xhigh ↯");
    renderer.shutdown();
  });

  it("hides the provider-default reasoning sentinel and non-priority tiers", () => {
    const { screen, renderer } = makeRenderer(100);
    renderer.renderNotice("anchor");
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel(
        "xai/grok-4.5",
        { kind: "gateway", connected: true, credential: "oidc" },
        {
          reasoning: "provider-default",
          providerOptions: { gateway: { serviceTier: "flex" } },
        },
      ),
    });
    renderer.setVercelStatus(vercelStatus);

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("xai/grok-4.5");
    expect(snapshot).not.toContain("@provider-default");
    expect(snapshot).not.toContain("↯");
    renderer.shutdown();
  });
});

describe("setup interaction transitions", () => {
  it.each([32, 80])(
    "anchors the heading from loading through filtering at %i columns",
    async (columns) => {
      const { screen, input, renderer } = makeRenderer(columns);
      renderer.setupFlow.begin("Add to your agent");
      const titleRow = () =>
        screen
          .snapshot()
          .split("\n")
          .findIndex((row) => row.includes("Add to your agent"));
      const initialRow = titleRow();
      renderer.setupFlow.setStatus("Loading catalog…");
      expect(titleRow()).toBe(initialRow);
      const answer = renderer.setupFlow.readSelect({
        kind: "search",
        message: "Add to your agent",
        options: [
          { value: "slack", label: "Slack" },
          { value: "linear", label: "Linear" },
        ],
      });
      const questionRow = titleRow();
      expect(questionRow).toBeGreaterThan(initialRow);
      expect(screen.snapshot().split("Add to your agent")).toHaveLength(2);
      input.type("sl");
      expect(titleRow()).toBe(questionRow);
      input.send("\x1b");
      input.send("\x1b");
      await expect(answer).resolves.toBeUndefined();
      expect(screen.snapshot()).not.toContain("Working…");
      renderer.setupFlow.end({ preserveDiagnostics: false });
      renderer.shutdown();
      expect(screen.snapshot()).not.toContain("Add to your agent");
    },
  );
});

describe("TerminalRenderer conversation", () => {
  let sequence = 0;
  const stamped = (event: UnstampedMessageStreamEvent) => stampTestEvent(event, ++sequence);
  const turn = (turnId: string) => stamped(createTurnStartedEvent({ sequence: 0, turnId }));
  const appended = (turnId: string, messageDelta: string) =>
    stamped(createMessageAppendedEvent({ messageDelta, sequence: 1, stepIndex: 0, turnId }));
  const completed = (turnId: string, message: string) =>
    stamped(createMessageCompletedEvent({ message, sequence: 2, stepIndex: 0, turnId }));

  it("streams prose in the live region and commits it whole once it settles", async () => {
    const { screen, renderer } = makeRenderer(34, 8);
    const prompt = readPrompt(renderer);
    const words = Array.from(
      { length: 44 },
      (_, index) => `word-${String(index + 1).padStart(2, "0")}`,
    );
    const streaming = [turn("turn_1"), ...words.map((word) => appended("turn_1", `${word} `))];

    renderer.renderConversation(conversationOf(streaming, { working: true }));
    expect(screen.snapshot()).toContain("earlier rows hidden");
    expect(screen.snapshot()).not.toContain("word-01");

    renderer.renderConversation(
      conversationOf([...streaming, completed("turn_1", words.join(" "))]),
    );
    const snapshot = screen.snapshot();
    expect(countOccurrences(snapshot, "word-01")).toBe(1);
    expect(countOccurrences(snapshot, "word-44")).toBe(1);
    expect(snapshot).not.toContain("earlier rows hidden");
    renderer.requestInterrupt();
    await prompt.catch(() => {});
  });

  it("rides the turn bar above an open composer and closes a long turn with a coda", async () => {
    vi.useFakeTimers();
    try {
      const { screen, renderer } = makeRenderer();
      const first = readPrompt(renderer);
      renderer.renderConversation(conversationOf([turn("turn_1")], { working: true }));
      let lines = screen.snapshot().split("\n");
      const bar = lines.findIndex((line) => line === "• Thinking (0s)");
      expect(bar).toBeGreaterThan(-1);
      expect(lines[bar + 2]).toContain("❯");

      await vi.advanceTimersByTimeAsync(12_000);
      renderer.renderConversation(
        conversationOf([turn("turn_1"), completed("turn_1", "Alice's summary is ready.")], {
          data: { usage: { inputTokens: 1_200, outputTokens: 300 } },
        }),
      );
      lines = screen.snapshot().split("\n");
      expect(lines.some((line) => line.includes("Thinking ("))).toBe(false);
      expect(screen.snapshot()).toMatch(/Done in 12s/u);
      renderer.requestInterrupt();
      await first.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks to cancel on Esc while work runs, then stops following on a second Ctrl+C", async () => {
    const { screen, input, renderer } = makeRenderer();
    renderer.renderConversation(conversationOf([turn("turn_1")], { working: true }));

    const cancel = renderer.readInput();
    input.send("\x1b");
    await expect(cancel).resolves.toEqual({ type: "cancel" });
    const interrupt = renderer.readInput();
    expect(screen.snapshot()).toContain("Cancelling turn…");
    input.ctrlC();
    await expect(interrupt).resolves.toEqual({ type: "interrupt" });

    // The interrupt counts as the first exit press at the next idle prompt.
    renderer.renderConversation(conversationOf([]));
    const idle = renderer.readInput();
    expect(screen.snapshot()).toContain("Press Ctrl+C again to exit");
    input.ctrlC();
    await expect(idle).rejects.toThrow("Interrupted");
  });

  it("submits a message typed while work runs", async () => {
    const { input, renderer } = makeRenderer();
    renderer.renderConversation(conversationOf([turn("turn_1")], { working: true }));
    const submitted = renderer.readInput();
    input.type("Include Bob's note.");
    input.enter();
    await expect(submitted).resolves.toEqual({ type: "submit", text: "Include Bob's note." });
    renderer.shutdown();
  });

  it("keeps the draft when the composer closes for another surface", async () => {
    const { screen, input, renderer } = makeRenderer();
    const controller = new AbortController();
    const closed = renderer.readInput({ signal: controller.signal });
    input.type("half a thought");
    controller.abort();
    await expect(closed).resolves.toBeUndefined();

    const reopened = readPrompt(renderer);
    expect(screen.snapshot()).toContain("❯ half a thought");
    input.enter();
    await expect(reopened).resolves.toBe("half a thought");
    renderer.shutdown();
  });

  it("settles the old conversation at a session boundary so a new session can reuse its ids", async () => {
    const { screen, renderer } = makeRenderer();
    const prompt = readPrompt(renderer);
    renderer.renderConversation(
      conversationOf([turn("turn_1"), appended("turn_1", "Alice's draft")], { working: true }),
    );
    renderer.renderSessionBoundary();
    renderer.renderConversation(conversationOf([]));
    renderer.renderConversation(
      conversationOf([turn("turn_1"), completed("turn_1", "Bob's fresh start.")]),
    );
    const snapshot = screen.snapshot();
    expect(countOccurrences(snapshot, "Alice's draft")).toBe(1);
    expect(countOccurrences(snapshot, "Bob's fresh start.")).toBe(1);
    expect(snapshot.indexOf("Alice's draft")).toBeLessThan(snapshot.indexOf("Session restarted"));
    renderer.requestInterrupt();
    await prompt.catch(() => {});
  });

  it("names the dynamic model the running turn resolved", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithDynamicModel(),
    });
    const prompt = readPrompt(renderer);
    expect(screen.snapshot()).toContain("dynamic model");
    renderer.renderConversation(
      conversationOf([turn("turn_1")], { data: { modelId: "openai/gpt-5.6-luna" } }),
    );
    expect(screen.snapshot()).toContain("dynamic model · openai/gpt-5.6-luna");
    renderer.requestInterrupt();
    await prompt.catch(() => {});
  });
});

import { describe, expect, it, vi } from "vitest";

import type { AgentInfoResult } from "#client/index.js";
import { searchActionValue } from "#setup/cli/select-state.js";
import {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  STRUCTURAL_RELOAD_LOG_LINE,
  formatChangeDetectedLogLine,
} from "#internal/nitro/host/dev-watcher-log.js";

import type { AgentTUIStreamEvent, AgentTUIStreamResult } from "./runner.js";
import { TerminalRenderer } from "./terminal-renderer.js";
import { MockScreen, MockUserInput } from "./test/mock-terminal.js";

function streamOf(events: AgentTUIStreamEvent[]): AgentTUIStreamResult {
  return {
    events: new ReadableStream<AgentTUIStreamEvent>({
      start(controller) {
        for (const event of events) controller.enqueue(event);
        controller.close();
      },
    }),
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

function agentInfoWithModel(
  modelId: string,
  endpoint?: AgentInfoResult["agent"]["model"]["endpoint"],
): AgentInfoResult {
  return {
    agent: {
      agentRoot: "/tmp/weather-agent/agent",
      appRoot: "/tmp/weather-agent",
      model: {
        id: modelId,
        endpoint,
      },
      name: "Weather Agent",
    },
    capabilities: {
      devRoutes: true,
    },
    channels: {
      authored: [],
      available: [],
      disabledFramework: [],
      framework: [],
    },
    connections: [],
    diagnostics: {
      discoveryErrors: 0,
      discoveryWarnings: 0,
    },
    hooks: [],
    instructions: {
      dynamic: [],
      static: null,
    },
    kind: "eve-agent-info",
    mode: "development",
    sandbox: null,
    schedules: [],
    skills: {
      dynamic: [],
      static: [],
    },
    subagents: {
      local: [],
      total: 0,
    },
    tools: {
      authored: [],
      available: [],
      disabledFramework: [],
      dynamic: [],
      framework: [],
      reserved: [],
    },
    version: 1,
    workflow: {
      enabled: false,
      toolName: "Workflow",
    },
    workspace: {
      resourceRoot: null,
      rootEntries: [],
    },
  };
}

describe("TerminalRenderer (inline scrollback)", () => {
  it("renders the brand line with the agent name and a tip", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("gpt-5"),
      tip: "Use /channels to add more ways to reach your agent.",
    });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("eve Weather Agent");
    expect(snapshot).toContain("Use /channels to add more ways to reach your agent.");
    // The model lives on the status line, not the header; the old config
    // rows and key hints are gone.
    expect(snapshot).not.toContain("gpt-5");
    expect(snapshot).not.toContain("http://localhost:3000");
    expect(snapshot).not.toContain("Type to chat");
  });

  it("refreshes the committed agent header with the latest model", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({
      info: agentInfoWithModel("old-model"),
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
    });
    await renderer.renderStream(
      streamOf([
        { type: "assistant-delta", id: "t1", delta: "still here" },
        { type: "assistant-complete", id: "t1" },
        { type: "finish" },
      ]),
      { submittedPrompt: "hello", continueSession: true },
    );

    renderer.renderAgentHeader({
      info: agentInfoWithModel("new-model"),
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
    });

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("new-model");
    expect(snapshot).not.toContain("old-model");
    expect(snapshot).toContain("hello");
    expect(snapshot).toContain("still here");
    renderer.shutdown();
  });

  it("streams an assistant message and a tool call into scrollback", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        {
          type: "step-start",
        },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "get_weather",
          input: { city: "SF" },
        },
        { type: "tool-result", toolCallId: "c1", output: { tempF: 73 } },
        { type: "assistant-delta", id: "t1", delta: "It's **73°F** in SF." },
        { type: "assistant-complete", id: "t1" },
        { type: "finish" },
      ]),
      { submittedPrompt: "weather in SF?", continueSession: false },
    );

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("weather in SF?");
    expect(snapshot).toContain("get_weather");
    expect(snapshot).toContain("It's 73°F in SF.");
  });

  it("omits the interrupt hint while waiting for the first stream event", async () => {
    const { screen, renderer } = makeRenderer();
    let streamController: ReadableStreamDefaultController<AgentTUIStreamEvent> | undefined;
    const rendering = renderer.renderStream(
      {
        events: new ReadableStream<AgentTUIStreamEvent>({
          start(controller) {
            streamController = controller;
          },
        }),
      },
      { submittedPrompt: "hello", continueSession: true },
    );

    await Promise.resolve();
    expect(screen.snapshot()).toContain("Working…");
    expect(screen.snapshot()).not.toContain("Ctrl+C to interrupt");

    streamController?.close();
    await rendering;
    renderer.shutdown();
  });

  it("uses the turn pulse while waiting for the first stream event", async () => {
    vi.useFakeTimers();
    try {
      const { screen, renderer } = makeRenderer();
      renderer.renderAgentHeader({
        name: "Weather Agent",
        serverUrl: "http://localhost:3000",
        info: agentInfoWithModel("gpt-5"),
      });
      let streamController: ReadableStreamDefaultController<AgentTUIStreamEvent> | undefined;
      const rendering = renderer.renderStream(
        {
          events: new ReadableStream<AgentTUIStreamEvent>({
            start(controller) {
              streamController = controller;
            },
          }),
        },
        { submittedPrompt: "hello", continueSession: true },
      );

      await Promise.resolve();
      let lines = screen.snapshot().split("\n");
      let workingRow = lines.findIndex((line) => line === "  ⊙ Working…");
      expect(workingRow).toBeGreaterThan(-1);
      expect(lines[workingRow + 1]).toBe("");
      expect(lines[workingRow + 2]).toContain("gpt-5");

      vi.advanceTimersByTime(450);
      expect(screen.snapshot()).not.toContain("⊙ Working…");
      lines = screen.snapshot().split("\n");
      workingRow = lines.findIndex((line) => line === "    Working…");
      expect(workingRow).toBeGreaterThan(-1);
      expect(lines[workingRow + 1]).toBe("");
      expect(lines[workingRow + 2]).toContain("gpt-5");

      streamController?.close();
      await rendering;
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
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
    const prompt = renderer.readPrompt();

    input.type("hello");
    input.enter();

    expect(await prompt).toBe("hello");
    expect(screen.snapshot()).toContain("  o Working…");
    expect(screen.snapshot()).not.toContain("⊙");
    renderer.shutdown();
  });

  it("interrupts a running response and returns to the prompt without exiting", async () => {
    const { screen, input, renderer } = makeRenderer();
    let streamController: ReadableStreamDefaultController<AgentTUIStreamEvent> | undefined;
    const abort = vi.fn();
    const rendering = renderer.renderStream(
      {
        abort,
        events: new ReadableStream<AgentTUIStreamEvent>({
          start(controller) {
            streamController = controller;
          },
        }),
      },
      { submittedPrompt: "start a long response", continueSession: true },
    );

    streamController?.enqueue({
      type: "assistant-delta",
      id: "t1",
      delta: "partial response",
    });
    await vi.waitFor(() => {
      expect(screen.snapshot()).toContain("partial response");
    });

    // The first Ctrl+C aborts the in-flight turn and unblocks the render
    // loop even though the server stream never closes on its own. Draining
    // instead would wait forever for an event that never arrives.
    input.ctrlC();
    await expect(rendering).resolves.toBeUndefined();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(screen.snapshot()).toContain("Interrupted");
    expect(input.rawModes).toEqual([true]);
    expect(screen.rawOutput()).toContain("\x1b[?2004h");

    // Control returns to the prompt rather than exiting; the next prompt works.
    const nextPrompt = renderer.readPrompt();
    input.type("still here");
    input.enter();
    await expect(nextPrompt).resolves.toBe("still here");

    renderer.shutdown();
    expect(input.rawModes).toEqual([true, false]);
    expect(screen.rawOutput()).toContain("\x1b[?2004l");
  });

  it("reassembles and renders a byte-split multi-line paste", async () => {
    const { screen, input, renderer } = makeRenderer();
    const text = "first 😀\nsecond 界";

    const prompt = renderer.readPrompt();
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

  it("clears a non-empty prompt on Ctrl+C, and quits only when already empty", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("draft message");
    input.ctrlC(); // first Ctrl+C clears the buffer instead of quitting
    input.type("real message");
    input.enter();

    // The cleared draft is gone (otherwise this would be "draft messagereal message").
    expect(await prompt).toBe("real message");

    // A Ctrl+C on the now-empty prompt quits.
    const second = renderer.readPrompt();
    input.ctrlC();
    await expect(second).rejects.toThrow();

    renderer.shutdown();
  });

  it("windows a line longer than the terminal around the caret", async () => {
    const { screen, input, renderer } = makeRenderer(20); // narrow terminal

    const prompt = renderer.readPrompt();
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

    const prompt = renderer.readPrompt();
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
      const prompt = renderer.readPrompt();
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

    const prompt = renderer.readPrompt();
    input.type("line one");
    input.send("\x1b[27;2;13~"); // Shift+Enter (xterm modifyOtherKeys)
    input.type("line two");
    input.enter();

    expect(await prompt).toBe("line one\nline two");
    renderer.shutdown();
  });

  it("moves the caret into the line above on ↑, then edits it", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
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

    const prompt = renderer.readPrompt();
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

  it("renders reused stream block ids across separate prompt turns", async () => {
    const { screen, renderer } = makeRenderer();

    await renderer.renderStream(
      streamOf([
        { type: "tool-call", toolCallId: "call_get_weather", toolName: "get_weather", input: {} },
        { type: "tool-result", toolCallId: "call_get_weather", output: { tempF: 72 } },
        { type: "assistant-delta", id: "text:turn-0:0", delta: "first answer" },
        { type: "assistant-complete", id: "text:turn-0:0" },
        { type: "finish" },
      ]),
      { submittedPrompt: "first prompt", continueSession: true },
    );

    await renderer.renderStream(
      streamOf([
        { type: "tool-call", toolCallId: "call_get_weather", toolName: "get_weather", input: {} },
        { type: "tool-result", toolCallId: "call_get_weather", output: { tempF: 73 } },
        { type: "assistant-delta", id: "text:turn-0:0", delta: "second answer" },
        { type: "assistant-complete", id: "text:turn-0:0" },
        { type: "finish" },
      ]),
      { submittedPrompt: "second prompt", continueSession: true },
    );
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("first answer");
    expect(snapshot).toContain("second answer");
    expect(countOccurrences(snapshot, "get_weather")).toBe(2);
  });

  it("settles a tool block when its result arrives in a later stream pass", async () => {
    const { screen, renderer } = makeRenderer();

    await renderer.renderStream(
      streamOf([
        { type: "tool-call", toolCallId: "call_bash", toolName: "bash", input: { command: "ls" } },
        { type: "finish" },
      ]),
      { submittedPrompt: "list files", continueSession: true },
    );
    expect(screen.snapshot()).toContain("bash");
    expect(screen.snapshot()).not.toContain("✓ bash");

    await renderer.renderStream(
      streamOf([
        {
          type: "tool-result",
          toolCallId: "call_bash",
          output: { exitCode: 0, stderr: "", stdout: "weather-codes.md\n" },
        },
        { type: "finish" },
      ]),
      { continueSession: true },
    );
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("✓ bash");
  });

  it("does not commit partial live assistant rows while streaming over the viewport", async () => {
    const { screen, renderer } = makeRenderer(34, 8);
    const words = Array.from(
      { length: 44 },
      (_, index) => `word-${String(index + 1).padStart(2, "0")}`,
    );
    await renderer.renderStream(
      streamOf([
        ...words.map((word) => ({
          type: "assistant-delta" as const,
          id: "t1",
          delta: `${word} `,
        })),
        { type: "assistant-complete", id: "t1" },
        { type: "finish" },
      ]),
      { submittedPrompt: "overflow please", continueSession: false },
    );

    const snapshot = screen.snapshot();
    expect(countOccurrences(snapshot, "word-01")).toBe(1);
    expect(countOccurrences(snapshot, "word-22")).toBe(1);
    expect(countOccurrences(snapshot, "word-44")).toBe(1);
  });

  it("strips terminal controls from streamed and out-of-band content", async () => {
    const { screen, renderer } = makeRenderer(100, 40);
    const osc = "\x1b]52;c;cGFzdGU=\x07";
    const dcs = "\x1bPqpayload\x1b\\";
    const c1Osc = "\u009d0;title\u009c";

    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.upsertConnectionAuth({
      name: `conn${osc}`,
      description: `desc ${osc}`,
      state: "required",
      challenge: {
        url: `https://example.com/${osc}`,
        userCode: `code${dcs}`,
        instructions: `follow ${c1Osc}`,
      },
      reason: `because ${osc}`,
    });

    await renderer.renderStream(
      streamOf([
        { type: "reasoning-delta", id: "r1", delta: `safe reason ${osc}` },
        { type: "reasoning-complete", id: "r1" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: `get_weather${osc}`,
          input: { [`city${osc}`]: `SF${dcs}` },
        },
        { type: "tool-result", toolCallId: "c1", output: { text: `done ${c1Osc}` } },
        { type: "assistant-delta", id: "t1", delta: `safe assistant ${osc}` },
        { type: "assistant-complete", id: "t1" },
        { type: "error", errorText: `session failed ${dcs}`, detail: `detail ${osc}` },
        { type: "finish" },
      ]),
      { continueSession: true, reasoning: "full", tools: "full" },
    );

    renderer.upsertSubagentStep({
      callId: "s1",
      subagentName: `researcher${osc}`,
      sectionKey: 0,
      reasoning: `child reason ${osc}`,
      message: `child message ${dcs}`,
      finalized: true,
    });
    renderer.upsertSubagentTool({
      callId: "s1",
      subagentName: `researcher${osc}`,
      childCallId: "cc1",
      toolName: `lookup${osc}`,
      input: { query: `weather${dcs}` },
      status: "done",
      output: { result: `clear${c1Osc}` },
    });

    const raw = screen.rawOutput();
    expect(raw).toContain("safe assistant");
    expect(raw).toContain("safe reason");
    expect(raw).toContain("get_weather");
    expect(raw).toContain("session failed");
    expect(raw).toContain("researcher");
    expect(raw).toContain("conn");
    expect(raw).not.toContain("\x1b]");
    expect(raw).not.toContain("\x1bP");
    expect(raw).not.toContain("\x1b\\");
    expect(raw).not.toContain("\x07");
    expect(raw).not.toContain("\u009d");
    expect(raw).not.toContain("\u009c");
    renderer.shutdown();
  });

  it("nests subagent steps and tools under a subagent header", async () => {
    const { screen, renderer } = makeRenderer();
    // The runner makes the renderer interactive via the startup header before
    // any subagent activity arrives.
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.upsertSubagentStep({
      callId: "s1",
      subagentName: "researcher",
      sectionKey: 0,
      reasoning: "comparing cities",
      message: "Looking into NYC.",
      finalized: true,
    });
    renderer.upsertSubagentTool({
      callId: "s1",
      subagentName: "researcher",
      childCallId: "cc1",
      toolName: "get_weather",
      input: { city: "NYC" },
      status: "done",
      output: { tempF: 61 },
    });

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("researcher");
    expect(snapshot).toContain("subagent");
    expect(snapshot).toContain("get_weather");
    renderer.shutdown();
  });

  it("recalls a previous prompt with the up arrow", async () => {
    const { input, renderer } = makeRenderer();

    const first = renderer.readPrompt();
    input.type("first message");
    input.enter();
    expect(await first).toBe("first message");

    const second = renderer.readPrompt();
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
    renderer.renderSetupWarning("1 setup issue: not logged in · /login");
    expect(screen.snapshot()).toContain("not logged in");

    renderer.clearSetupWarning();
    expect(screen.snapshot()).not.toContain("not logged in");
    renderer.shutdown();
  });

  it("hangs a command outcome under its invocation with the elbow connector", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandResult("/model cancelled.");
    renderer.shutdown();

    expect(screen.snapshot()).toContain("\u23bf  /model cancelled.");
  });

  it("shows a bare prompt with no placeholder and accepts typing", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    // A bare prompt before any info/turn has no status row (no ↑ 0 ↓ 0 counter).
    expect(screen.snapshot()).not.toContain("↑ 0");
    expect(screen.snapshot()).toContain("❯");
    expect(screen.snapshot()).not.toContain("Type to chat");
    expect(screen.rawOutput()).not.toContain("\x1b[48;5;");

    input.type("hello");
    input.enter();
    expect(screen.snapshot()).toContain("Working…");
    expect(await prompt).toBe("hello");
    renderer.shutdown();
  });

  it("starts the turn pulse as soon as the prompt is submitted", async () => {
    vi.useFakeTimers();
    try {
      const { screen, input, renderer } = makeRenderer();
      const prompt = renderer.readPrompt();

      input.type("hello");
      input.enter();

      expect(await prompt).toBe("hello");
      expect(screen.snapshot()).toContain("  ⊙ Working…");

      vi.advanceTimersByTime(450);
      expect(screen.snapshot()).not.toContain("⊙ Working…");
      expect(screen.snapshot()).toContain("    Working…");

      let streamController: ReadableStreamDefaultController<AgentTUIStreamEvent> | undefined;
      const rendering = renderer.renderStream(
        {
          events: new ReadableStream<AgentTUIStreamEvent>({
            start(controller) {
              streamController = controller;
            },
          }),
        },
        { continueSession: true },
      );
      await Promise.resolve();
      expect(screen.snapshot()).not.toContain("⊙ Working…");
      expect(screen.snapshot()).toContain("    Working…");

      streamController?.close();
      await rendering;
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the turn indicator when reasoning starts", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("gpt-5"),
    });
    let streamController: ReadableStreamDefaultController<AgentTUIStreamEvent> | undefined;
    const rendering = renderer.renderStream(
      {
        events: new ReadableStream<AgentTUIStreamEvent>({
          start(controller) {
            streamController = controller;
          },
        }),
      },
      { submittedPrompt: "weather in SF", continueSession: true },
    );

    streamController?.enqueue({ type: "reasoning-delta", id: "r1", delta: "thinking" });
    await vi.waitFor(() => {
      expect(screen.snapshot()).toContain("thinking");
    });
    const lines = screen.snapshot().split("\n");
    const thinkingRow = lines.findIndex((line) => line.includes("thinking"));
    const workingRow = lines.findIndex(
      (line) => line.includes("Working…") || line.includes("Responding…"),
    );
    const modelRow = lines.findIndex((line) => line.includes("gpt-5"));
    const inputRow = lines.findIndex((line) => line.includes("❯"));

    expect(thinkingRow).toBeGreaterThan(-1);
    expect(workingRow).toBe(-1);
    expect(lines[thinkingRow + 1]).toBe("");
    expect(modelRow).toBe(thinkingRow + 2);
    expect(inputRow).toBe(-1);

    streamController?.close();
    await rendering;
    renderer.shutdown();
  });

  it("seeds the editable buffer with an initial draft without auto-submitting", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt({ initialDraft: "hello world" });
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

    const prompt = renderer.readPrompt({
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
    expect(screen.snapshot()).toContain("⊙ Working…");
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

  it("renders the selected question option as a padded inverse-blue label", async () => {
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

    const selected = screen
      .snapshot()
      .split("\n")
      .find((line) => line.includes("AI Gateway"));
    expect(selected).toContain(" ▶ AI Gateway ");
    expect(screen.rawOutput()).toContain("\x1b[7m");
    expect(screen.rawOutput()).toContain("\x1b[34m");

    const selectedDescriptionColumn = selected?.indexOf("— Managed access");
    expect(selectedDescriptionColumn).toBeGreaterThanOrEqual(0);
    input.down();
    const unselected = screen
      .snapshot()
      .split("\n")
      .find((line) => line.includes("AI Gateway"));
    expect(unselected?.indexOf("— Managed access")).toBe(selectedDescriptionColumn);
    input.up();

    input.enter();
    await expect(answer).resolves.toEqual({ optionId: "gateway" });
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

  it("paints a fully typed known command blue in the input line", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("/channels");
    // The ANSI blue open (34) wraps the typed command in the painted row.
    expect(screen.rawOutput()).toContain("[34m/channels");
    input.enter();
    await prompt;
    renderer.shutdown();
  });

  it("leaves unknown input unstyled in the input line", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    // Never passes through a known command, even if painted per keystroke
    // ("/li…" is not "/channels").
    input.type("/lin is not a command");
    expect(screen.rawOutput()).not.toContain("[34m");
    input.enter();
    await prompt;
    renderer.shutdown();
  });

  it("echoes slash commands as command lines, never as user messages", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("/new");
    input.enter();
    expect(await prompt).toBe("/new");
    renderer.shutdown();

    // The echo anchors in the user-message grammar (gutter bar), never the
    // prompt glyph: that one is the live-input rendezvous marker.
    expect(screen.snapshot()).toContain("\u258c /new");
    expect(screen.snapshot()).not.toContain("\u276f /new");
  });

  it("reassembles an arrow key split across reads", async () => {
    const { input, renderer } = makeRenderer();

    const first = renderer.readPrompt();
    input.type("remembered");
    input.enter();
    await first;

    const second = renderer.readPrompt();
    input.send("\x1b"); // ESC arrives on its own…
    input.send("[A"); // …and the CSI tail follows in a later read.
    input.enter();
    expect(await second).toBe("remembered");
    renderer.shutdown();
  });

  it("inserts text at the caret after moving left", async () => {
    const { input, renderer } = makeRenderer();
    const prompt = renderer.readPrompt();
    input.type("helo");
    input.left();
    input.type("l");
    input.enter();
    expect(await prompt).toBe("hello");
    renderer.shutdown();
  });

  it("coalesces consecutive same-source writes into one labeled log run", () => {
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
    // A non-log block ends the run…
    renderer.renderNotice("turn boundary");
    // …so the next write starts a fresh labeled run.
    process.stdout.write("post-turn line\n");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // Two runs → the source label appears exactly twice, not once per line.
    expect(countOccurrences(snapshot, "stdout ·")).toBe(2);
    expect(snapshot).toContain("weather lookup { city: 'NY' }");
    expect(snapshot).toContain("weather lookup { city: 'LA' }");
    expect(snapshot).toContain("post-turn line");
    // The open run at shutdown is committed, not wiped with the live region.
    expect(snapshot.indexOf("post-turn line")).toBeGreaterThan(snapshot.indexOf("turn boundary"));
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

    // Restored lines reappear at their original transcript positions:
    // stdout before the notice, stderr after it.
    const restored = screen.snapshot();
    expect(restored.indexOf("before-boundary stdout")).toBeGreaterThan(-1);
    expect(restored.indexOf("before-boundary stdout")).toBeLessThan(
      restored.indexOf("turn boundary"),
    );
    expect(restored.indexOf("turn boundary")).toBeLessThan(
      restored.indexOf("after-boundary stderr"),
    );
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
    expect(snapshot.indexOf("captured while hidden")).toBeGreaterThan(-1);
    expect(snapshot.indexOf("captured while hidden")).toBeLessThan(
      snapshot.indexOf("after the log"),
    );
  });

  it("keeps log-run labels consistent with what is visible", () => {
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

    // The hidden stdout line must not split the visible stderr run.
    expect(countOccurrences(screen.snapshot(), "stderr ·")).toBe(1);

    renderer.setLogDisplayMode("all");
    renderer.shutdown();

    // Once visible, the stdout line splits the stderr run in two — labels
    // re-derive from what is actually rendered, not from capture order.
    const snapshot = screen.snapshot();
    expect(countOccurrences(snapshot, "stderr ·")).toBe(2);
    expect(countOccurrences(snapshot, "stdout ·")).toBe(1);
    expect(snapshot.indexOf("first stderr line")).toBeLessThan(
      snapshot.indexOf("interleaved stdout line"),
    );
    expect(snapshot.indexOf("interleaved stdout line")).toBeLessThan(
      snapshot.indexOf("second stderr line"),
    );
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
    expect(snapshot).not.toContain("stdout ·");
    expect(snapshot).not.toContain("stderr ·");
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

  it("renders subscribed sandbox logs under the sandbox log level", () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      logs: "sandbox",
      unicode: true,
    });
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    renderer.renderSandboxLog?.('eve: sandbox template "root" (docker): checking Docker daemon');
    renderer.renderSandboxLog?.("eve: initializing 3 sandbox templates...");
    renderer.renderSandboxLog?.('eve: built sandbox template "root" on backend "docker".');
    renderer.renderSandboxLog?.("ordinary stdout log");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain('sandbox · built sandbox template "root" on backend "docker".');
    expect(snapshot).not.toContain("initializing 3 sandbox templates");
    expect(snapshot).not.toContain("checking Docker daemon");
    expect(snapshot).not.toContain("ordinary stdout log");
    expect(snapshot).not.toContain("stdout ·");
  });

  it("cycles the log mode on Ctrl+L with a transient status hint that clears after 5s", () => {
    vi.useFakeTimers();
    try {
      const screen = new MockScreen({ columns: 100, rows: 30 });
      const input = new MockUserInput();
      const renderer = new TerminalRenderer({ input, output: screen, unicode: true });
      void renderer.readPrompt();

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
    expect(countOccurrences(live, "stdout ·")).toBe(1);

    // Shutdown settles the status row into scrollback instead of wiping it.
    renderer.shutdown();
    expect(screen.snapshot()).toContain("tui/setup-panel.ts changed · rebuilt");
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

  it("settles a live rebuild cycle at stream end and starts the next one fresh", async () => {
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

    // The rebuild line lands mid-stream, after the assistant block opened.
    async function* events(): AsyncGenerator<AgentTUIStreamEvent> {
      yield { type: "assistant-delta", id: "t1", delta: "hello there" };
      process.stdout.write(
        `${formatChangeDetectedLogLine("/app", [{ event: "change", path: "/app/agent/agent.ts" }])}\n`,
      );
      yield { type: "finish" };
    }
    await renderer.renderStream(
      { events: events() },
      { submittedPrompt: "hi", continueSession: true },
    );

    // Stream-end finalize froze the cycle mid-"rebuilding"; the next change
    // detected after it opens a fresh row instead of rewriting the old one.
    process.stdout.write(
      `${formatChangeDetectedLogLine("/app", [
        { event: "change", path: "/app/agent/tools/lookup.ts" },
      ])}\n`,
    );
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot.indexOf("agent/agent.ts changed · rebuilding…")).toBeGreaterThan(-1);
    expect(snapshot.indexOf("agent/agent.ts changed · rebuilding…")).toBeLessThan(
      snapshot.indexOf("tools/lookup.ts changed · rebuilding…"),
    );
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
    expect(snapshot.indexOf(AUTHORED_ARTIFACTS_UPDATED_LOG_LINE)).toBeLessThan(
      snapshot.indexOf("tools/lookup.ts changed · rebuilding…"),
    );
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

    expect(screen.snapshot()).toContain("stderr · [eve:dev] rebuild failed");
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

    expect(screen.snapshot()).toContain("stderr · [eve:dev] rebuild failed");
    expect(screen.snapshot()).toContain("missing export");
    renderer.shutdown();
  });

  it("marks a tool block denied when the user rejects the approval", async () => {
    const { screen, input, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        { type: "tool-call", toolCallId: "c1", toolName: "delete_files", input: { path: "/" } },
        { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" },
      ]),
      { submittedPrompt: "clean up", continueSession: true },
    );

    const approval = renderer.readToolApproval({
      approvalId: "a1",
      toolCallId: "c1",
      toolName: "delete_files",
      input: { path: "/" },
    });
    input.type("n");
    expect(await approval).toEqual({ approved: false, reason: "Denied by user." });
    expect(screen.snapshot()).toContain("⊙ Working…");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("delete_files");
    expect(snapshot).toContain("→ denied");
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

  it("refreshing the agent header preserves committed transcript and scrollback", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.renderNotice("previous transcript");

    // Dev HMR refresh: a fresh header is committed beneath the transcript —
    // nothing is cleared or replayed.
    renderer.renderAgentHeader({ name: "Weather Agent v2", serverUrl: "http://localhost:3000" });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("previous transcript");
    expect(snapshot).toContain("Weather Agent v2");
    // The refreshed header lands after the prior transcript, not on a wiped screen.
    expect(snapshot.indexOf("Weather Agent v2")).toBeGreaterThan(
      snapshot.indexOf("previous transcript"),
    );
  });

  it("does not repeat the banner when a source reload re-sends an unchanged header", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.renderNotice("previous transcript");

    // Every runtime-artifacts change re-sends the header; an identical one
    // must not stack another banner under the transcript.
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.shutdown();

    expect(countOccurrences(screen.snapshot(), "Weather Agent")).toBe(1);
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

  it("toggles a multi-select with space and confirms from the Submit row", async () => {
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

  it("renames the hovered editable row directly via typing and backspace", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.setupFlow.readEditableSelect?.({
      message: "Vercel project",
      options: [
        { value: "new", label: "Create a new project", hint: "Named 'weather-agent'" },
        { value: "link", label: "Link an existing project" },
      ],
      initialValue: "new",
      editable: {
        value: "new",
        defaultValue: "weather-agent",
        formatHint: (value) => `Named '${value}'`,
      },
    });
    expect(answer).toBeDefined();

    // Hovering the editable row is already a live field — no → to enter.
    expect(screen.snapshot()).toContain("type to rename");
    expect(screen.snapshot()).toContain("Named 'weather-agent");
    // Backspace edits the seeded default in place, exactly like typing.
    input.backspace();
    input.backspace();
    // "nt" trimmed off the end of the seeded default.
    expect(screen.snapshot()).not.toContain("weather-agent");
    input.type("!");
    expect(screen.snapshot()).toContain("Named 'weather-age!");
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
        { value: "new", label: "Create a new project", hint: "Named 'weather-agent'" },
        { value: "link", label: "Link an existing project" },
      ],
      initialValue: "new",
      editable: {
        value: "new",
        defaultValue: "weather-agent",
        formatHint: (value) => `Named '${value}'`,
      },
    });
    expect(answer).toBeDefined();

    // Enter without editing resolves to the default name, not a rename.
    input.enter();
    await expect(answer).resolves.toEqual({ kind: "selected", value: "new" });
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

  it("commits toned flow lines to the transcript", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.renderLine("Connected the agent to the Vercel AI Gateway.", "success");
    renderer.setupFlow.renderLine("visit https://vercel.com/connect", "info");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("✓ Connected the agent to the Vercel AI Gateway.");
    expect(snapshot).toContain("· visit https://vercel.com/connect");
  });
});

describe("TerminalRenderer setup flow session", () => {
  it("uses the build-phase pulse for pulse setup flows", () => {
    vi.useFakeTimers();
    try {
      const { screen, renderer } = makeRenderer();

      renderer.setupFlow.begin("Configure the agent model", "pulse");
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

  it("uses an ASCII fallback for pulse setup flows", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: false,
    });

    renderer.setupFlow.begin("Configure the agent model", "pulse");
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
    expect(snapshot).toContain("/deploy");
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
    renderer.renderCommandResult("Project linked. Connected to AI Gateway via VERCEL_OIDC_TOKEN.");
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("Project name unavailable");
    expect(snapshot).not.toContain("already exists");
    expect(snapshot).toContain("Project linked. Connected to AI Gateway via VERCEL_OIDC_TOKEN.");
  });

  it("renders questions inside the open flow panel under its title", async () => {
    const { screen, input, renderer } = makeRenderer();

    renderer.setupFlow.begin("/deploy");
    renderer.setupFlow.renderLine("This directory is not linked yet.", "info");
    const answer = renderer.setupFlow.readSelect({
      kind: "single",
      message: "Vercel project",
      options: [{ value: "new", label: "Create a new project" }],
    });

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("/deploy");
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
      { value: "done", label: "Done" },
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
      kind: "task-list",
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
    // Focused completed row reads inert: a dim pointer, not a check.
    expect(snapshot).toContain("▷ Terminal UI · Already installed");
    expect(snapshot).not.toContain("✓ Terminal UI");
    expect(snapshot).toContain("✓ Web Chat");
    expect(snapshot).toContain("Slack       · Creates slackbot and deploys to Vercel");
    expect(snapshot.indexOf("Done")).toBeLessThan(snapshot.indexOf("Overwrote /tmp/weather-agent"));
    expect(snapshot.indexOf("Overwrote /tmp/weather-agent")).toBeLessThan(
      snapshot.indexOf("Scaffolded channel: web"),
    );
    expect(snapshot.indexOf("Scaffolded channel: web")).toBeLessThan(snapshot.indexOf("↑/↓ move"));
    expect(snapshot).toContain("Dependency installation failed.");

    input.send("\x1b");
    await expect(third).resolves.toBeUndefined();
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
        { value: "done", label: "Done" },
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
    await expect(interrupt.promise).resolves.toBeUndefined();

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
    const prompt = renderer.readPrompt();
    input.type("/channels");
    input.enter();
    await prompt;
    renderer.renderCommandResult("Project linked.");
    renderer.shutdown();

    const lines = screen.snapshot().split("\n");
    const echoIndex = lines.findIndex((line) => line.includes("▌ /channels"));
    expect(echoIndex).toBeGreaterThan(0);
    expect(lines[echoIndex - 1]).toBe("");
    const resultIndex = lines.findIndex((line) => line.includes("⎿  Project linked."));
    expect(resultIndex).toBe(echoIndex + 1);
  });
});

describe("TerminalRenderer command typeahead", () => {
  it("offers command suggestions while the draft is a lone slash token", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("/");
    const snapshot = screen.snapshot();
    expect(snapshot).toContain("/help");
    expect(snapshot).toContain("Show available commands");
    expect(snapshot).toContain("Configure the agent's model and provider");
    const promptLine = snapshot.split("\n").find((line) => line.includes("❯ /"));
    expect(promptLine?.startsWith(" ❯ /")).toBe(true);

    input.enter();
    // The highlighted default — /help leads the registry — is what a bare
    // slash submits.
    expect(await prompt).toBe("/help");
    renderer.shutdown();
  });

  it("collapses a complete command into an inline argument hint", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("/model");
    const snapshot = screen.snapshot();
    // The prompt row carries the dim argument shape inline (the caret sits
    // between the typed name and the hint)...
    expect(snapshot).toContain("/model");
    expect(snapshot).toContain("[provider/model]");
    // ...and the dropdown (with its description column) is gone.
    expect(snapshot).not.toContain("Configure the agent's model and provider");

    input.enter();
    expect(await prompt).toBe("/model");
    renderer.shutdown();
  });

  it("tab completes the highlighted command without submitting", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
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

    const prompt = renderer.readPrompt();
    input.type("/chan");
    input.enter();
    expect(await prompt).toBe("/channels");
    renderer.shutdown();

    expect(screen.snapshot()).toContain("▌ /channels");
    expect(screen.snapshot()).not.toContain("❯ /channels");
  });

  it("submits an alias as typed instead of canonicalizing it", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("/quit");
    input.enter();
    expect(await prompt).toBe("/quit");
    renderer.shutdown();

    expect(screen.snapshot()).toContain("▌ /quit");
  });

  it("moves the suggestion highlight with arrows instead of recalling history", async () => {
    const { input, renderer } = makeRenderer();

    const first = renderer.readPrompt();
    input.type("an earlier prompt");
    input.enter();
    await first;

    const second = renderer.readPrompt();
    input.type("/");
    input.down();
    input.enter();
    // Down moved /help → /new; history recall would have submitted the
    // earlier prompt instead.
    expect(await second).toBe("/new");
    renderer.shutdown();
  });

  it("escape dismisses the suggestions until the draft changes", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("/");
    expect(screen.snapshot()).toContain("Show available commands");

    input.send("\x1b");
    // A lone ESC is held ~30ms before it flushes as a key.
    await vi.waitFor(() => {
      expect(screen.snapshot()).not.toContain("Show available commands");
    });

    input.type("m");
    expect(screen.snapshot()).toContain("Configure the agent's model and provider");
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
});

describe("TerminalRenderer status line", () => {
  const vercelStatus = {
    identity: { projectName: "my-agent", teamName: "acme" },
    pendingDeploy: false,
  };

  it("renders model and Vercel link under the prompt row", async () => {
    const { screen, input, renderer } = makeRenderer();
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("anthropic/claude-sonnet-4-6", {
        kind: "gateway",
        connected: true,
        credential: "oidc",
      }),
    });

    const prompt = renderer.readPrompt();
    renderer.setVercelStatus(vercelStatus);

    const lines = screen.snapshot().split("\n");
    const promptRow = lines.findIndex((line) => line.includes("❯"));
    expect(promptRow).toBeGreaterThan(-1);
    const statusRow = lines.slice(promptRow + 1).join("\n");
    expect(statusRow).toContain("anthropic/claude-sonnet-4-6");
    // The linked project folds into the connected gateway label.
    expect(statusRow).toContain("AI Gateway (my-agent)");
    // No token segment before any turn reports usage (↑ 0 ↓ 0 is noise).
    expect(statusRow).not.toContain("↑ 0");
    expect(statusRow).not.toContain("/deploy pending");

    input.enter();
    await prompt;
    renderer.shutdown();
  });

  it("marks a pending deploy in yellow", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderNotice("anchor");
    renderer.setVercelStatus({ ...vercelStatus, pendingDeploy: true });

    expect(screen.snapshot()).toContain("/deploy pending");
    expect(screen.rawOutput()).toContain("[33m/deploy pending");
    renderer.shutdown();
  });

  it("suppresses the status line while a setup flow panel is open", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderNotice("anchor");
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("anthropic/claude-sonnet-4-6", {
        kind: "gateway",
        connected: true,
        credential: "oidc",
      }),
    });
    renderer.setVercelStatus(vercelStatus);
    expect(screen.snapshot()).toContain("AI Gateway (my-agent)");

    renderer.setupFlow.begin("Connect to Vercel");
    expect(screen.snapshot()).not.toContain("AI Gateway (my-agent)");

    renderer.setupFlow.end({ preserveDiagnostics: false });
    expect(screen.snapshot()).toContain("AI Gateway (my-agent)");
    renderer.shutdown();
  });

  it("keeps the running token total after the turn indicator disappears", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        { type: "step-start" },
        { type: "assistant-delta", id: "t1", delta: "Hi." },
        { type: "assistant-complete", id: "t1" },
        { type: "finish", usage: { inputTokens: 500, outputTokens: 300 } },
      ]),
      { submittedPrompt: "hello", continueSession: true },
    );

    const lines = screen.snapshot().split("\n");
    const readyRow = lines.find((line) => line.includes("Ready"));
    const statusRow = lines.find((line) => line.includes("↑ 500 ↓ 300"));
    expect(readyRow).toBeUndefined();
    expect(statusRow).toBeDefined();
    renderer.shutdown();
  });

  it("keeps the model and Vercel segments across reset while tokens clear", async () => {
    // 100 columns: all four segments fit at full fidelity, no drop order.
    const { screen, renderer } = makeRenderer(100);
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("anthropic/claude-sonnet-4-6", {
        kind: "gateway",
        connected: true,
        credential: "oidc",
      }),
    });
    renderer.setVercelStatus({ ...vercelStatus, pendingDeploy: true });
    await renderer.renderStream(
      streamOf([
        { type: "step-start" },
        { type: "assistant-delta", id: "t1", delta: "Hi." },
        { type: "assistant-complete", id: "t1" },
        { type: "finish", usage: { inputTokens: 500, outputTokens: 300 } },
      ]),
      { submittedPrompt: "hello", continueSession: true },
    );
    expect(screen.snapshot()).toContain("↑ 500 ↓ 300");

    renderer.reset();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("anthropic/claude-sonnet-4-6");
    expect(snapshot).toContain("AI Gateway (my-agent)");
    expect(snapshot).toContain("/deploy pending");
    // A fresh conversation clears the token flow entirely (↑ 0 ↓ 0 is noise).
    expect(snapshot).not.toContain("↑ 0");
    expect(snapshot).not.toContain("↑ 500");
    expect(snapshot).not.toContain("hello");
    renderer.shutdown();
  });
});

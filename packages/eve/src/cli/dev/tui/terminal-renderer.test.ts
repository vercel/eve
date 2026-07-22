import { describe, expect, it, vi } from "vitest";

import type { AgentInfoResult } from "#client/index.js";
import type { LogRecord } from "#internal/logging.js";
import type { DevDiagnostics } from "../diagnostics.js";
import { searchActionValue } from "#setup/cli/select-state.js";
import {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  STRUCTURAL_RELOAD_LOG_LINE,
  formatChangeDetectedLogLine,
} from "#internal/nitro/host/dev-watcher-log.js";

import type { AgentTUIStreamEvent, AgentTUIStreamResult, SubagentToolUpdate } from "./runner.js";
import { promptCommandsFor } from "./prompt-commands.js";
import { PROMPT_PLACEHOLDER_MESSAGES } from "./prompt-placeholder.js";
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

function agentInfoWithModel(
  modelId: string,
  endpoint?: AgentInfoResult["agent"]["model"]["endpoint"],
  extras?: Partial<AgentInfoResult["agent"]["model"]>,
): AgentInfoResult {
  return {
    agent: {
      agentRoot: "/tmp/weather-agent/agent",
      appRoot: "/tmp/weather-agent",
      model: {
        id: modelId,
        endpoint,
        ...extras,
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
  it("prints the dim wordmark tag as the parting line after a Ctrl-C exit", async () => {
    const { screen, input, renderer } = makeRenderer();
    const prompt = renderer.readPrompt();
    // Ctrl-C at the prompt restores the terminal inside the reader itself;
    // the runner's teardown-time shutdown() must still print the tag.
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

  it("renders rejected tools as denied", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "rm something" },
        },
        { type: "tool-rejected", toolCallId: "c1", reason: "Denied by user." },
        { type: "finish" },
      ]),
      { submittedPrompt: "remove it", continueSession: false },
    );

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("Run rm something");
    expect(snapshot).toContain("denied");
    expect(snapshot).not.toContain("✓ Run");
    renderer.shutdown();
  });

  it("renders web_fetch as a concise semantic activity", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        {
          type: "tool-call",
          toolCallId: "fetch-1",
          toolName: "web_fetch",
          input: {
            format: "markdown",
            url: "https://github.com/vercel/eve/issues/648",
          },
        },
        {
          type: "tool-result",
          toolCallId: "fetch-1",
          output: { content: "large fetched page" },
        },
        { type: "finish" },
      ]),
      { submittedPrompt: "fetch the issue", continueSession: false },
    );

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("Fetched https://github.com/vercel/eve/issues/648");
    expect(snapshot).not.toContain("format=markdown");
    expect(snapshot).not.toContain("large fetched page");
    renderer.shutdown();
  });

  it("coalesces a same-status fetch cohort without merging call state", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        {
          type: "tool-call",
          toolCallId: "fetch-1",
          toolName: "web_fetch",
          input: { url: "https://one.example" },
        },
        {
          type: "tool-call",
          toolCallId: "fetch-2",
          toolName: "web_fetch",
          input: { url: "https://two.example" },
        },
        { type: "tool-result", toolCallId: "fetch-1", output: { content: "one" } },
        { type: "tool-result", toolCallId: "fetch-2", output: { content: "two" } },
        { type: "finish" },
      ]),
      { submittedPrompt: "call fetch twice in parallel", continueSession: false },
    );

    const snapshot = screen.snapshot();
    // A fully settled batch collapses to one past-tense line; the item rail
    // is gone from the transcript.
    expect(snapshot).toContain("│ call fetch twice in parallel\n\n  ▪ Fetched 2 URLs");
    expect(snapshot).not.toContain("https://one.example");
    expect(snapshot).not.toContain("https://two.example");
    renderer.shutdown();
  });

  it("partitions a fetch cohort with interleaved failures into per-outcome groups", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        {
          type: "tool-call",
          toolCallId: "fetch-1",
          toolName: "web_fetch",
          input: { url: "https://one.example" },
        },
        {
          type: "tool-call",
          toolCallId: "fetch-2",
          toolName: "web_fetch",
          input: { url: "https://two.example" },
        },
        {
          type: "tool-call",
          toolCallId: "fetch-3",
          toolName: "web_fetch",
          input: { url: "https://three.example" },
        },
        {
          type: "tool-call",
          toolCallId: "fetch-4",
          toolName: "web_fetch",
          input: { url: "https://four.example" },
        },
        { type: "tool-result", toolCallId: "fetch-1", output: { content: "one" } },
        { type: "tool-error", toolCallId: "fetch-2", errorText: "status 403" },
        { type: "tool-result", toolCallId: "fetch-3", output: { content: "three" } },
        { type: "tool-error", toolCallId: "fetch-4", errorText: "status 429" },
        { type: "finish" },
      ]),
      { submittedPrompt: "fetch four urls", continueSession: false },
    );
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // Successes collapse to a counted past-tense line; failures keep their
    // itemized rail, newest call first, closed by the corner.
    expect(snapshot).toContain("▪ Fetched 2 URLs");
    expect(snapshot).not.toContain("https://one.example");
    expect(snapshot).toContain(
      "  ⨯ Fetch 2 URLs\n  │ https://four.example status 429\n  │ https://two.example  status 403\n  └",
    );
  });

  it("renders a write as an all-added diff for a new file and a real diff after a read", async () => {
    const { screen, renderer } = makeRenderer(120, 60);
    await renderer.renderStream(
      streamOf([
        {
          type: "tool-call",
          toolCallId: "write-1",
          toolName: "write_file",
          input: { filePath: "/workspace/knicks.txt", content: "knicks\n" },
        },
        {
          type: "tool-result",
          toolCallId: "write-1",
          output: { existed: false, path: "/workspace/knicks.txt" },
        },
        {
          type: "tool-call",
          toolCallId: "write-2",
          toolName: "write_file",
          input: { filePath: "/workspace/knicks.txt", content: "knicks\nnets\n" },
        },
        {
          type: "tool-result",
          toolCallId: "write-2",
          output: { existed: true, path: "/workspace/knicks.txt" },
        },
        { type: "finish" },
      ]),
      { submittedPrompt: "write the teams", continueSession: false },
    );
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // First write: the file did not exist, so its content is all additions.
    expect(snapshot).toContain("  ▪ Wrote /workspace/knicks.txt\n  │+ knicks\n  └");
    // Second write diffs against the first write's cached content.
    expect(snapshot).toContain("  │  knicks\n  │+ nets\n  └");
  });

  it("renders interleaved tool lifecycles in arrival order", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        {
          type: "tool-call",
          toolCallId: "first",
          toolName: "first_search",
          input: { query: "first" },
        },
        { type: "tool-result", toolCallId: "first", output: { result: "first result" } },
        {
          type: "tool-call",
          toolCallId: "second",
          toolName: "second_search",
          input: { query: "second" },
        },
        { type: "tool-result", toolCallId: "second", output: { result: "second result" } },
        { type: "finish" },
      ]),
      { submittedPrompt: "run both searches", continueSession: false },
    );

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("▪ first_search");
    expect(snapshot).toContain("first result");
    expect(snapshot).toContain("▪ second_search");
    expect(snapshot).toContain("second result");
    expect(snapshot.indexOf("first_search")).toBeLessThan(snapshot.indexOf("second_search"));
    renderer.shutdown();
  });

  it("renders a concurrent tool batch before any result arrives", async () => {
    const { screen, renderer } = makeRenderer(120, 140);
    let streamController: ReadableStreamDefaultController<AgentTUIStreamEvent> | undefined;
    const rendering = renderer.renderStream(
      {
        events: new ReadableStream<AgentTUIStreamEvent>({
          start(controller) {
            streamController = controller;
          },
        }),
      },
      { submittedPrompt: "search the tri-state area", continueSession: true },
    );

    const controller = streamController;
    expect(controller).toBeDefined();
    controller?.enqueue({ type: "step-start" });
    for (let index = 1; index <= 100; index += 1) {
      controller?.enqueue({
        type: "tool-call",
        toolCallId: `search-${index}`,
        toolName: "web_search",
        input: { query: `tri-state-${index}` },
      });
    }

    await screen.waitForText("Search 100 queries");

    const snapshot = screen.snapshot();
    // Semantic copy coalesces the running batch into one counted row that
    // lists the newest calls first and elides the rest; nothing may render
    // as completed yet.
    expect(snapshot.match(/tri-state-\d+/g)).toHaveLength(5);
    expect(snapshot).toContain("tri-state-100");
    expect(snapshot).toContain("(95 more)");
    expect(snapshot).not.toContain("Searched");
    expect(snapshot).not.toContain("web_search");

    controller?.close();
    await rendering;
    renderer.shutdown();
  });

  it("shows a placeholder while a call's input streams, then upgrades it in place", async () => {
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
      { submittedPrompt: "fetch the page", continueSession: true },
    );

    const controller = streamController;
    controller?.enqueue({ type: "step-start" });
    controller?.enqueue({ type: "tool-call-preparing", toolCallId: "c1", toolName: "web_fetch" });
    await screen.waitForText("Fetch …");

    controller?.enqueue({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "web_fetch",
      input: { url: "https://example.com" },
    });
    await screen.waitForText("Fetch https://example.com");

    const snapshot = screen.snapshot();
    // The placeholder upgraded in place: one block, no leftover "Fetch …" row.
    expect(snapshot).not.toContain("Fetch …");
    expect(countOccurrences(snapshot, "Fetch https://example.com")).toBe(1);

    controller?.close();
    await rendering;
    renderer.shutdown();
  });

  it("renders a preparing subagent tool row and upgrades it with the full call", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.upsertSubagentTool({
      callId: "s1",
      subagentName: "researcher",
      childCallId: "cc1",
      toolName: "web_fetch",
      input: undefined,
      status: "preparing",
    });
    expect(screen.snapshot()).toContain("Fetch …");

    renderer.upsertSubagentTool({
      callId: "s1",
      subagentName: "researcher",
      childCallId: "cc1",
      toolName: "web_fetch",
      input: { url: "https://example.com" },
      status: "executing",
    });
    const snapshot = screen.snapshot();
    expect(snapshot).toContain("Fetch https://example.com");
    expect(snapshot).not.toContain("Fetch …");
    renderer.shutdown();
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
    expect(screen.snapshot()).toContain("W 1s");
    expect(screen.snapshot()).not.toContain("Ctrl+C to interrupt");

    streamController?.close();
    await rendering;
    renderer.shutdown();
  });

  it("keeps the authorization wait status while consuming a callback stream", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.setConnectionAuthPendingCount(1);
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
    // The bar renders; connection state lives in its own section.
    expect(screen.snapshot()).toContain("W 1s");

    streamController?.close();
    await rendering;
    renderer.shutdown();
  });

  it("shows the live turn bar while waiting for the first stream event", async () => {
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
      // The label types itself out: one character at t=0.
      let barRow = lines.findIndex((line) => line === "▪ W 1s");
      expect(barRow).toBeGreaterThan(-1);
      // The pending prompt row wears the same quiet `›` as the idle one
      // beneath the bar; the status line follows it.
      expect(lines[barRow + 1]).toBe("");
      expect(lines[barRow + 2]).toContain("›");
      expect(lines[barRow + 4]).toContain("gpt-5");

      // The duration ticks live while the pulse blinks on the shared beat.
      await vi.advanceTimersByTimeAsync(2_000);
      lines = screen.snapshot().split("\n");
      // Fully revealed once the reveal window has passed.
      barRow = lines.findIndex((line) => line.includes("Working for 2s"));
      expect(barRow).toBeGreaterThan(-1);
      expect(lines[barRow + 2]).toContain("›");
      expect(lines[barRow + 4]).toContain("gpt-5");

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
    expect(screen.snapshot()).toContain("* W 1s");
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
    expect(screen.snapshot()).toContain("Run ls");
    expect(screen.snapshot()).not.toContain("Ran ls");

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
    expect(snapshot).toContain("▪ Ran ls");
  });

  it("settles an authorization block when its callback arrives in a later stream pass", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.upsertConnectionAuth({
      name: "linear",
      description: "Authorization required for linear",
      state: "required",
      challenge: { url: "https://connect.vercel.com/authorize/linear" },
    });

    await renderer.renderStream(streamOf([{ type: "finish" }]), { continueSession: true });

    renderer.upsertConnectionAuth({
      name: "linear",
      description: "Authorization required for linear",
      state: "pending",
      challenge: { url: "https://connect.vercel.com/authorize/linear" },
    });
    expect(screen.snapshot()).toContain("linear · authorization · pending");

    await renderer.renderStream(streamOf([{ type: "finish" }]), { continueSession: true });

    renderer.upsertConnectionAuth({
      name: "linear",
      description: "Authorization required for linear",
      state: "authorized",
      challenge: { url: "https://connect.vercel.com/authorize/linear" },
    });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("linear · authorization · authorized");
    expect(snapshot).toContain("Authorization complete");
    expect(snapshot).not.toContain("linear · authorization · required");
    expect(snapshot).not.toContain("linear · authorization · pending");
    expect(snapshot).not.toContain("Authorization required for linear");
    expect(snapshot).not.toContain("https://connect.vercel.com/authorize/linear");
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
    expect(snapshot).toContain("※ subagent(researcher)");
    expect(snapshot).toContain("get_weather");
    renderer.shutdown();
  });

  it("swaps a dispatch's preparing placeholder for the section header", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

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

    // The model commits to the `agent` tool; its input streams.
    streamController?.enqueue({
      type: "tool-call-preparing",
      toolCallId: "sub1",
      toolName: "agent",
    });
    await screen.waitForText("Delegate");

    // Subagent dispatches never upgrade the placeholder (their actions are
    // not tool-call kind) — subagent.called supersedes it with the section.
    renderer.markChildToolCallId("sub1");
    renderer.beginSubagent({ callId: "sub1", name: "agent" });
    await screen.waitForText("※ subagent(self)");

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("※ subagent(self)");
    expect(snapshot).not.toContain("Delegate");

    streamController?.close();
    await rendering;
    renderer.shutdown();

    // The step-boundary ghost sweep must not take the section with it.
    expect(screen.snapshot()).toContain("※ subagent(self)");
  });

  it("windows subagent children by latest activity, not announce order", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });

    // A parallel batch: every call announced up front…
    const names = ["web_fetch", "web_search", "bash", "read_file"];
    const upsert = (i: number, status: "executing" | "done") => {
      const update: SubagentToolUpdate = {
        callId: "s1",
        subagentName: "agent",
        childCallId: `c${i}`,
        toolName: names[i % names.length]!,
        input: { url: `u${i}`, query: `q${i}`, command: `cmd${i}`, filePath: `f${i}` },
        status,
      };
      if (status === "done") update.output = { ok: true };
      renderer.upsertSubagentTool(update);
    };
    for (let i = 1; i <= 8; i += 1) upsert(i, "executing");
    // …then the FIRST two settle: they are the most recent activity and
    // must enter the window, displacing later-announced idle calls.
    upsert(1, "done");
    upsert(2, "done");

    const snapshot = screen.snapshot();
    // The window is the single most recently active call — c2 settled last.
    expect(snapshot).toContain("Ran cmd2");
    expect(snapshot).toContain("(7 more)");
    expect(snapshot).not.toContain("cmd6");
    renderer.shutdown();
  });

  it("collapses a completed section to its Done header and activity footnote", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    renderer.upsertSubagentStep({
      callId: "s1",
      subagentName: "echo-marker",
      sectionKey: 0,
      reasoning: "",
      message: "SUBAGENT_TOKEN=echo-marker-9F2X",
      finalized: true,
    });
    renderer.upsertSubagentTool({
      callId: "s1",
      subagentName: "echo-marker",
      childCallId: "cc1",
      toolName: "web_fetch",
      input: { url: "https://one.example" },
      status: "done",
      output: { ok: true },
    });

    // Mid-flight the section shows its newest child and closes on a bare
    // corner (the tool arrived after the message, so it holds the window).
    expect(screen.snapshot()).toContain("Fetched https://one.example");
    expect(screen.snapshot()).not.toContain("Done");

    renderer.completeSubagent({ callId: "s1" });
    const snapshot = screen.snapshot();
    // Completed: the corner reports Done with the counted footnote and the
    // children fold away — the parent's reply carries the conclusion.
    expect(snapshot).toContain("※ subagent(echo-marker)");
    expect(snapshot).toContain("  └ Done. Fetched 1 URL");
    expect(snapshot).not.toContain("SUBAGENT_TOKEN=echo-marker-9F2X");
    renderer.shutdown();
  });

  it("renders parallel calls to the same subagent as ordinal-numbered sections", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    const calls = [
      ["s1", "echo-marker-1"],
      ["s2", "echo-marker-2"],
      ["s3", "echo-marker-3"],
    ] as const;
    for (const finalized of [false, true]) {
      for (const [callId, token] of calls) {
        renderer.upsertSubagentStep({
          callId,
          subagentName: "echo-marker",
          sectionKey: 0,
          reasoning: "",
          message: `SUBAGENT_TOKEN=${token}`,
          finalized,
        });
      }
    }
    await renderer.renderStream(streamOf([{ type: "finish" }]), { continueSession: true });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // Each call keeps its own persistent section, told apart by ordinal.
    expect(countOccurrences(snapshot, "※ subagent(echo-marker:")).toBe(3);
    expect(snapshot).toContain("※ subagent(echo-marker:1)");
    expect(snapshot).toContain("※ subagent(echo-marker:2)");
    expect(snapshot).toContain("※ subagent(echo-marker:3)");
    expect(snapshot).toContain("SUBAGENT_TOKEN=echo-marker-1");
    expect(snapshot).toContain("SUBAGENT_TOKEN=echo-marker-2");
    expect(snapshot).toContain("SUBAGENT_TOKEN=echo-marker-3");
  });

  it("windows one subagent's children to the most recent row", async () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderAgentHeader({ name: "Weather Agent", serverUrl: "http://localhost:3000" });
    for (let step = 1; step <= 8; step += 1) {
      renderer.upsertSubagentStep({
        callId: "s1",
        subagentName: "echo-marker",
        sectionKey: step,
        reasoning: "",
        message: `SUBAGENT_TOKEN=token-${step}`,
        finalized: true,
      });
    }
    await renderer.renderStream(streamOf([{ type: "finish" }]), { continueSession: true });
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(countOccurrences(snapshot, "※ subagent(echo-marker)")).toBe(1);
    // A lone call carries no ordinal; only the newest child row shows.
    expect(snapshot).not.toContain("#1");
    expect(snapshot).toContain("(7 more)");
    expect(snapshot).not.toContain("SUBAGENT_TOKEN=token-7");
    expect(snapshot).toContain("SUBAGENT_TOKEN=token-8");
  });

  it("commits the one-line session boundary", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderNotice("anchor");
    renderer.renderSessionBoundary();
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("┌── Session restarted, clear context.");
  });

  it("closes the dying turn's coda and dismisses the todo panel at the boundary", async () => {
    const { screen, input, renderer } = makeRenderer();
    const prompt = renderer.readPrompt();
    input.type("hey agent");
    input.enter();
    expect(await prompt).toBe("hey agent");

    await renderer.renderStream(
      streamOf([
        { type: "step-start" },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "todo",
          input: {
            todos: [
              { content: "first task", status: "in_progress" },
              { content: "second task", status: "pending" },
            ],
          },
        },
        { type: "assistant-delta", id: "m1", delta: "working" },
        { type: "assistant-complete", id: "m1" },
        { type: "step-finish", usage: { inputTokens: 25_000, outputTokens: 40 } },
        { type: "finish", usage: { inputTokens: 25_000, outputTokens: 40 } },
      ]),
      { continueSession: true },
    );
    expect(screen.snapshot()).toContain("first task");

    renderer.renderSessionBoundary();
    const snapshot = screen.snapshot();
    // The dead turn's stats close before the boundary, not after it…
    expect(snapshot.indexOf("└ Done in")).toBeGreaterThan(-1);
    expect(snapshot.indexOf("└ Done in")).toBeLessThan(snapshot.indexOf("┌── Session restarted"));
    // …and the discarded session's plan dismisses instead of lingering.
    expect(snapshot).not.toContain("first task");

    // Control returning to the prompt must not add a second coda.
    const second = renderer.readPrompt();
    expect(countOccurrences(screen.snapshot(), "└ Done in")).toBe(1);
    input.ctrlC();
    await expect(second).rejects.toThrow();
    renderer.shutdown();
  });

  it("shows a typed mid-stream draft behind a dim inert prompt mark", async () => {
    const { screen, input, renderer } = makeRenderer();
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

    // Empty: the quiet idle mark.
    expect(screen.snapshot()).toContain("›");

    // A typed draft flips to the active mark, but dim — Enter is inert, so
    // the cyan ready state would overclaim.
    input.type("next question");
    await screen.waitForText("❯ next question");
    expect(screen.rawOutput()).toContain("\x1b[2m❯\x1b[22m");
    expect(screen.rawOutput()).not.toContain("\x1b[36m❯");

    streamController?.close();
    await rendering;
    renderer.shutdown();
  });

  it("never submits an empty or whitespace-only prompt", async () => {
    const { input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
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
    renderer.renderSetupWarning("1 setup issue: not logged in · /vc:login");
    expect(screen.snapshot()).toContain("not logged in");

    renderer.clearSetupWarning();
    expect(screen.snapshot()).not.toContain("not logged in");
    renderer.shutdown();
  });

  it("hangs a command outcome under its invocation with the elbow connector", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandResult("/model dismissed.");
    renderer.shutdown();

    expect(screen.snapshot()).toContain("\u23bf  /model dismissed.");
  });

  it("marks a failed automatic command and keeps its multiline outcome in one result block", () => {
    const { screen, renderer } = makeRenderer();
    renderer.renderCommandInvocation("/vc:login", "failed");
    renderer.renderCommandResult(
      "Authentication was refreshed, but example.vercel.app is unavailable: Access denied.\n\n" +
        "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
    );
    renderer.shutdown();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("│ ⨯ /vc:login");
    expect(snapshot).toContain("⎿  Authentication was refreshed");
    expect(snapshot).toContain("TRUSTED_SOURCES_ENVIRONMENT_MISMATCH");
    expect(snapshot).not.toContain("· Authentication was refreshed");
  });

  it("invites with a quiet placeholder until typing starts", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    // A bare prompt before any info/turn has no status row (no ↑ 0 ↓ 0 counter).
    expect(screen.snapshot()).not.toContain("↑ 0");
    // Empty buffer: the quiet `›` gutter with the rotation's first message.
    expect(screen.snapshot()).toContain(`› ${PROMPT_PLACEHOLDER_MESSAGES[0]}`);
    expect(screen.snapshot()).not.toContain("❯");
    expect(screen.rawOutput()).not.toContain("\x1b[48;5;");

    input.type("hello");
    // Typing swaps in the active prompt mark and clears the invitation.
    expect(screen.snapshot()).toContain("❯ hello");
    expect(screen.snapshot()).not.toContain(PROMPT_PLACEHOLDER_MESSAGES[0]);
    input.enter();
    expect(screen.snapshot()).toContain("W 1s");
    expect(await prompt).toBe("hello");
    renderer.shutdown();
  });

  it("shows the live turn bar as soon as the prompt is submitted", async () => {
    vi.useFakeTimers();
    try {
      const { screen, input, renderer } = makeRenderer();
      const prompt = renderer.readPrompt();

      input.type("hello");
      input.enter();

      expect(await prompt).toBe("hello");
      expect(screen.snapshot()).toContain("▪ W 1s");

      // The typewriter label advances while the submit wait ticks.
      vi.advanceTimersByTime(450);
      expect(screen.snapshot()).toContain("Workin");

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
      // The stream keeps the same bar — one working indicator end to end.
      expect(screen.snapshot()).not.toContain("⊙");
      expect(screen.snapshot()).toContain(" 1s");

      streamController?.close();
      await rendering;
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits an end-of-turn stats coda when control returns to the prompt", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("hey agent");
    input.enter();
    expect(await prompt).toBe("hey agent");

    await renderer.renderStream(
      streamOf([
        { type: "step-start" },
        { type: "assistant-delta", id: "m1", delta: "Hello!" },
        { type: "step-finish", usage: { inputTokens: 18_000, outputTokens: 40 } },
        { type: "step-start" },
        { type: "assistant-complete", id: "m1" },
        { type: "step-finish", usage: { inputTokens: 2_500, outputTokens: 3 } },
        // The finish event repeats the last step's usage; it must not
        // double-count into the turn total.
        { type: "finish", usage: { inputTokens: 2_500, outputTokens: 3 } },
      ]),
      { continueSession: true },
    );
    // Mid-turn (before control returns to the prompt) there is no coda —
    // multi-pass turns must end with exactly one.
    expect(screen.snapshot()).not.toContain("\n└ ");

    const second = renderer.readPrompt();
    // Tokens are the turn's summed step usage, not the last report; the sum
    // crossing the 20K input threshold is what earns the row.
    expect(screen.snapshot()).toContain("└ Done in 1s ── ↑ 20.5K ↓ 43");
    input.ctrlC();
    await expect(second).rejects.toThrow();
    renderer.shutdown();
  });

  it("closes a quick, cheap turn without a stats coda", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("hey");
    input.enter();
    expect(await prompt).toBe("hey");

    await renderer.renderStream(
      streamOf([
        { type: "step-start" },
        { type: "assistant-delta", id: "m1", delta: "Hi!" },
        { type: "assistant-complete", id: "m1" },
        { type: "step-finish", usage: { inputTokens: 4_500, outputTokens: 43 } },
        { type: "finish", usage: { inputTokens: 4_500, outputTokens: 43 } },
      ]),
      { continueSession: true },
    );

    // Under 10s and under 20K turn input: no coda row.
    const second = renderer.readPrompt();
    expect(screen.snapshot()).not.toContain("\n└ ");
    input.ctrlC();
    await expect(second).rejects.toThrow();
    renderer.shutdown();
  });

  it("retires the placeholder after the first user message", async () => {
    const { screen, input, renderer } = makeRenderer();

    const first = renderer.readPrompt();
    expect(screen.snapshot()).toContain(`› ${PROMPT_PLACEHOLDER_MESSAGES[0]}`);
    input.type("hello");
    input.enter();
    expect(await first).toBe("hello");

    // Once the user has spoken, the empty prompt keeps the quiet `›` but
    // drops the invitation text; typing still swaps in the active `❯`.
    const second = renderer.readPrompt();
    expect(screen.snapshot()).toContain("›");
    expect(screen.snapshot()).not.toContain("❯");
    expect(screen.snapshot()).not.toContain(PROMPT_PLACEHOLDER_MESSAGES[0]);
    input.type("again");
    expect(screen.snapshot()).toContain("❯ again");
    input.ctrlC();
    expect(screen.snapshot()).not.toContain("❯");
    input.ctrlC();
    await expect(second).rejects.toThrow();
    renderer.shutdown();
  });

  it("keeps collapsed reasoning out of the transcript behind the turn bar", async () => {
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

    await vi.waitFor(() => {
      expect(screen.snapshot()).toContain(" 1s");
    });
    streamController?.enqueue({
      type: "reasoning-delta",
      id: "r1",
      delta: "the plan is to check the forecast",
    });
    await Promise.resolve();
    // The trace never reaches the screen; the bar carries the turn.
    const lines = screen.snapshot().split("\n");
    const barRow = lines.findIndex((line) => line.includes(" 1s"));
    expect(barRow).toBeGreaterThan(-1);
    expect(screen.snapshot()).not.toContain("the plan is to check the forecast");
    // The pending prompt row holds its place below, then the status line.
    expect(lines[barRow + 2]).toContain("›");
    expect(lines[barRow + 4]).toContain("gpt-5");

    streamController?.enqueue({ type: "reasoning-complete", id: "r1" });
    streamController?.close();
    await rendering;
    expect(screen.snapshot()).not.toContain("the plan is to check the forecast");
    expect(screen.snapshot()).not.toContain("Thought for");
    renderer.shutdown();
  });

  it("closes a long thinking turn with the coda, not a thought bar", async () => {
    vi.useFakeTimers();
    try {
      const { screen, input, renderer } = makeRenderer();
      const prompt = renderer.readPrompt();
      input.type("hard question");
      input.enter();
      expect(await prompt).toBe("hard question");

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
      streamController?.enqueue({ type: "reasoning-delta", id: "r1", delta: "hm" });
      await vi.advanceTimersByTimeAsync(12_000);
      streamController?.enqueue({ type: "reasoning-complete", id: "r1" });
      streamController?.close();
      await rendering;

      // 12s of wall clock qualifies the coda; the thought itself leaves no
      // separate transcript bar.
      const second = renderer.readPrompt();
      expect(screen.snapshot()).toContain("└ Done in 12s");
      expect(screen.snapshot()).not.toContain("Thought for");
      input.ctrlC();
      await expect(second).rejects.toThrow();
      renderer.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the prompt in place during a turn with Enter inert, carrying the draft", async () => {
    const { screen, input, renderer } = makeRenderer();
    let streamController: ReadableStreamDefaultController<AgentTUIStreamEvent> | undefined;
    const rendering = renderer.renderStream(
      {
        events: new ReadableStream<AgentTUIStreamEvent>({
          start(controller) {
            streamController = controller;
          },
        }),
      },
      { submittedPrompt: "long task", continueSession: true },
    );

    await vi.waitFor(() => {
      // Empty draft: the pending prompt wears the same quiet `›` as idle
      // (readiness is signalled by the turn bar's absence, not the glyph).
      expect(screen.snapshot()).toContain("›");
    });
    input.type("follow-up question");
    // Enter is inert mid-turn — nothing submits, the draft stays.
    input.enter();
    await vi.waitFor(() => {
      expect(screen.snapshot()).toContain("❯ follow-up question");
    });

    streamController?.close();
    await rendering;

    // The draft seeds the next prompt instead of being lost.
    const prompt = renderer.readPrompt();
    expect(screen.snapshot()).toContain("❯ follow-up question");
    input.enter();
    expect(await prompt).toBe("follow-up question");
    renderer.shutdown();
  });

  it("waitForIdlePrompt ignores the pending prompt and resolves only at idle", async () => {
    const { screen, input, renderer } = makeRenderer();
    let streamController: ReadableStreamDefaultController<AgentTUIStreamEvent> | undefined;
    const rendering = renderer.renderStream(
      {
        events: new ReadableStream<AgentTUIStreamEvent>({
          start(controller) {
            streamController = controller;
          },
        }),
      },
      { submittedPrompt: "long task", continueSession: true },
    );

    await vi.waitFor(() => {
      // The pending prompt already shows `›` — but the live bar keeps the
      // idle predicate false.
      expect(screen.snapshot()).toContain("›");
    });
    await expect(screen.waitForIdlePrompt(200)).rejects.toThrow(/idle prompt/u);

    streamController?.close();
    await rendering;
    const prompt = renderer.readPrompt();
    await screen.waitForIdlePrompt(1_000);
    input.ctrlC();
    await expect(prompt).rejects.toThrow();
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
    expect(screen.snapshot()).toContain("W 1s");
    renderer.shutdown();
  });

  it("breathes between an answered question and the next tool block", async () => {
    const { screen, input, renderer } = makeRenderer();

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Which framework do you mean?",
      display: "text",
    });
    input.type("eve");
    input.enter();
    await answer;

    await renderer.renderStream(
      streamOf([
        { type: "step-start" },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "web_search",
          input: { query: "eve framework" },
        },
        { type: "finish" },
      ]),
      { continueSession: true },
    );

    // The answered question and the following tool are separated by air.
    expect(screen.snapshot()).toContain("⎿  eve\n\n");
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

  it("renders the question overlay with numbered rows and an inverse-blue cursor", async () => {
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
    expect(selected).toContain(" ▶ 1. AI Gateway ");
    expect(selected).toContain("↵");
    expect(screen.rawOutput()).toContain("\x1b[7m");
    expect(screen.rawOutput()).toContain("\x1b[34m");
    // Every option's description rides its own row, cursor or not.
    expect(lines).toContain("        Managed access");
    expect(lines).toContain("        Direct access");
    // The panel carries its one quiet hint; no status hint row beneath it.
    expect(snapshot).toContain("Esc to dismiss");
    expect(snapshot).not.toContain("Enter to select");
    expect(countOccurrences(snapshot, "Esc to")).toBe(1);

    input.down();
    const unselected = screen
      .snapshot()
      .split("\n")
      .find((line) => line.includes("AI Gateway"));
    expect(unselected).toContain("1. AI Gateway");
    expect(unselected).not.toContain("▶");
    input.up();

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
    expect(screen.snapshot()).toContain("Esc to dismiss");

    await escape();
    // No answer travels; the runner returns to the prompt and the server
    // records the parked request as ignored on the next message.
    await expect(answer).resolves.toBeUndefined();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("? Choose access");
    expect(snapshot).toContain("⎿  Dismissed.");
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
    input.type("2");
    input.type("draft answer");
    expect(screen.snapshot()).toContain("⎿ draft answer");

    await escape();
    expect(screen.snapshot()).not.toContain("draft answer");
    expect(screen.snapshot()).toContain("Esc to dismiss");

    await escape();
    await expect(answer).resolves.toBeUndefined();
    expect(screen.snapshot()).toContain("⎿  Dismissed.");
    renderer.shutdown();
  });

  it("sweeps a preparing placeholder whose call never parses", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        { type: "step-start" },
        // Announced, but no tool-call ever follows (the model emitted
        // unparsable input and retried under a fresh id next step).
        { type: "tool-call-preparing", toolCallId: "ghost-1", toolName: "web_search" },
        { type: "step-finish", usage: { inputTokens: 10, outputTokens: 5 } },
        { type: "step-start" },
        {
          type: "tool-call",
          toolCallId: "retry-1",
          toolName: "web_search",
          input: { query: "eve framework" },
        },
        { type: "tool-result", toolCallId: "retry-1", output: { results: [] } },
        { type: "step-finish", usage: { inputTokens: 10, outputTokens: 5 } },
        { type: "finish" },
      ]),
      { submittedPrompt: "search", continueSession: false },
    );
    renderer.shutdown();

    const snapshot = screen.snapshot();
    // The retry renders; the ghost placeholder never commits.
    expect(snapshot).toContain("Searched eve framework");
    expect(snapshot).not.toContain("Search …");
  });

  it("suppresses the tool block for ask_question calls", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        {
          type: "tool-call",
          toolCallId: "ask-1",
          toolName: "ask_question",
          input: { prompt: "Pick a color." },
        },
        { type: "finish" },
      ]),
      { submittedPrompt: "ask me", continueSession: false },
    );
    renderer.shutdown();

    // The question surface is the call's representation; no `Ask …` block.
    expect(screen.snapshot()).not.toContain("Ask Pick a color.");
  });

  it("selects a question option directly by its number key", async () => {
    const { input, renderer } = makeRenderer();

    const answer = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Choose access",
      display: "select",
      options: [
        { id: "gateway", label: "AI Gateway" },
        { id: "external", label: "Other providers" },
      ],
    });
    input.type("2");

    await expect(answer).resolves.toEqual({ optionId: "external" });
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

    expect(screen.snapshot()).toContain("3. Type your own answer");
    // The freeform row's number moves focus into its inline editor; typing
    // lands there without a separate enter.
    input.type("3");
    input.type("neither");
    expect(screen.snapshot()).toContain("⎿ neither");
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
    // First Esc only clears the draft; the question is still answerable.
    expect(screen.snapshot()).toContain("? What city are you in?");

    await escape();
    await expect(answer).resolves.toBeUndefined();
    expect(screen.snapshot()).toContain("⎿  Dismissed.");
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
    expect(screen.snapshot()).toContain("\u2502 /new");
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

  it("records tool failures in the diagnostic log even when tools are hidden", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const stub = stubDiagnostics();
    const append = stub.append;
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      tools: "hidden",
      unicode: true,
      diagnostics: stub.diagnostics,
    });

    await renderer.renderStream(
      streamOf([
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: { command: "curl https://example.com" },
        },
        { type: "tool-error", toolCallId: "c1", errorText: "exit code 7: connection refused" },
        { type: "error", errorText: "Turn failed." },
        { type: "finish" },
      ]),
      { submittedPrompt: "fetch it", continueSession: false },
    );

    expect(append).toHaveBeenCalledWith({
      source: "tool",
      summary: expect.stringContaining("failed"),
      detail: "exit code 7: connection refused",
    });
    expect(append).toHaveBeenCalledWith({
      source: "workflow",
      summary: "Error: Turn failed.",
      detail: "Turn failed.",
    });
    renderer.shutdown();
  });

  it("renders a cataloged summary for a recognized stream error and logs the raw dump", async () => {
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const input = new MockUserInput();
    const stub = stubDiagnostics();
    const append = stub.append;
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      diagnostics: stub.diagnostics,
    });

    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
        code: "ECONNREFUSED",
      }),
    });
    await renderer.renderStream(
      {
        events: new ReadableStream<AgentTUIStreamEvent>({
          start(controller) {
            controller.error(failure);
          },
        }),
      },
      { submittedPrompt: "hello", continueSession: false },
    );

    // Transcript: curated headline, the structured hint, and the log
    // pointer — no stack dump.
    expect(screen.snapshot()).toContain("Network request failed");
    expect(screen.snapshot()).toContain("Check your internet connection");
    expect(screen.snapshot()).toContain("details: .eve/logs/dev.log");
    expect(screen.snapshot()).not.toContain("    at ");
    // Log: the raw inspection, cause chain included, hint structured.
    expect(append).toHaveBeenCalledWith({
      source: "workflow",
      summary: expect.stringContaining("Network request failed"),
      detail: expect.stringContaining("ECONNREFUSED"),
      hint: expect.stringContaining("Check your internet connection"),
    });
    renderer.shutdown();
  });

  it("records session stats past display guards and reports at the turn boundary", async () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const stub = stubDiagnostics();
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      tools: "hidden",
      subagents: "hidden",
      unicode: true,
      diagnostics: stub.diagnostics,
    });

    renderer.upsertSubagentTool({
      callId: "sub-1",
      subagentName: "echo-marker",
      childCallId: "child-1",
      toolName: "echo",
      input: {},
      status: "executing",
    });
    await renderer.renderStream(
      streamOf([
        { type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} },
        { type: "tool-call", toolCallId: "c2", toolName: "bash", input: {} },
        { type: "tool-call", toolCallId: "c3", toolName: "weather", input: {} },
        { type: "step-finish", usage: { inputTokens: 100, outputTokens: 20 } },
        { type: "step-finish", usage: { inputTokens: 40, outputTokens: 5 } },
        // `finish` replays the last step's usage; only step-finish records.
        { type: "finish", usage: { inputTokens: 40, outputTokens: 5 } },
      ]),
      { submittedPrompt: "run it", continueSession: false },
    );

    expect(stub.recordPrompt).toHaveBeenCalledTimes(1);
    expect(stub.recordSubagentDispatch).toHaveBeenCalledWith("sub-1");
    expect(stub.recordToolCall.mock.calls.map(([name]) => name)).toEqual([
      "bash",
      "bash",
      "weather",
    ]);
    expect(stub.recordStepUsage).toHaveBeenCalledTimes(2);
    expect(stub.reportStats).toHaveBeenCalled();
    renderer.shutdown();
  });

  it("records sandbox log lines in the diagnostic log", () => {
    const screen = new MockScreen({ columns: 80, rows: 30 });
    const input = new MockUserInput();
    const stub = stubDiagnostics();
    const append = stub.append;
    const renderer = new TerminalRenderer({
      input,
      output: screen,
      captureForeignOutput: false,
      unicode: true,
      diagnostics: stub.diagnostics,
    });

    renderer.renderSandboxLog('eve: sandbox template "root" (microsandbox): apt-get update');
    expect(append).toHaveBeenCalledWith({ source: "sandbox", detail: expect.any(String) });
    renderer.shutdown();
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
    expect(snapshot).not.toContain("○ stdout");
  });

  it("cycles the log mode on Ctrl+L with a transient status hint that clears after 5s", () => {
    vi.useFakeTimers();
    try {
      const screen = new MockScreen({ columns: 100, rows: 30 });
      const input = new MockUserInput();
      const renderer = new TerminalRenderer({ input, output: screen, unicode: true });
      // Abandoned on purpose; shutdown() rejects it with InterruptedError.
      renderer.readPrompt().catch(() => {});

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
    expect(screen.snapshot()).toContain("W 1s");
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
      options: [{ value: "own-key", label: "AI Gateway via AI_GATEWAY_API_KEY" }],
      initialValue: "own-key",
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
      kind: "inline-key",
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
        options: [{ value: "own-key", label: "AI Gateway via AI_GATEWAY_API_KEY" }],
        initialValue: "own-key",
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
      options: [{ value: "own-key", label: "AI Gateway key" }],
      initialValue: "own-key",
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
      kind: "inline-key",
      key: "sk-second",
      validation: { kind: "valid" },
    });
    renderer.shutdown();
  });

  it("walks the model editor from pick to slider to toggle to Done", async () => {
    const { screen, input, renderer } = makeRenderer(100, 40);
    renderer.setupFlow.begin("Configure the agent model");
    const answer = renderer.setupFlow.readModelEditor({
      model: {
        kind: "pick",
        options: [
          {
            value: "anthropic/claude-sonnet-5",
            label: "anthropic/claude-sonnet-5",
            featured: true,
          },
          { value: "xai/grok-4.5", label: "xai/grok-4.5" },
        ],
        current: "anthropic/claude-sonnet-5",
      },
      reasoning: null,
      serviceTier: { kind: "standard" },
      settingsEditable: true,
      externalRouting: false,
      capabilitiesFor: () => ({
        reasoning: true,
        reasoningLevels: ["low", "high"],
        fastMode: true,
      }),
    });

    // The value menu opens on the Model row.
    expect(screen.snapshot()).toContain("▶ Model");
    input.enter();
    expect(screen.snapshot()).toContain("Select the model");
    input.type("grok");
    expect(screen.snapshot()).toContain("xai/grok-4.5");
    input.enter();
    // Back on the menu, the model hint carries the pick.
    expect(screen.snapshot()).toContain("xai/grok-4.5");

    // Reasoning adjusts inline on its row: right enters the scale at the
    // lowest level, another right (via Tab, which mimics it) walks up.
    input.down();
    expect(screen.snapshot()).toContain("▶ Reasoning effort");
    input.right();
    expect(screen.snapshot()).toContain("◉─○ low");
    input.send("\t");
    expect(screen.snapshot()).toContain("●─◉ high");

    input.down();
    expect(screen.snapshot()).toContain("▶ Service tier");
    expect(screen.snapshot()).toContain("normal");
    input.right();
    expect(screen.snapshot()).toContain("fast ↯");

    input.down();
    input.enter();

    await expect(answer).resolves.toEqual({
      model: "xai/grok-4.5",
      reasoning: "high",
      serviceTier: "priority",
    });
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.shutdown();
  });

  it("unwinds Esc through filter, sub-screen, and menu before cancelling", async () => {
    const { screen, input, renderer } = makeRenderer(100, 40);
    renderer.setupFlow.begin("Configure the agent model");
    const answer = renderer.setupFlow.readModelEditor({
      model: {
        kind: "pick",
        options: [{ value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" }],
        current: "anthropic/claude-sonnet-5",
      },
      reasoning: null,
      serviceTier: { kind: "standard" },
      settingsEditable: true,
      externalRouting: false,
      capabilitiesFor: () => undefined,
    });
    let settled = false;
    void answer.finally(() => {
      settled = true;
    });

    input.enter();
    input.type("sonnet");
    input.send("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    // The first Esc only cleared the filter; the list is still open.
    expect(screen.snapshot()).toContain("▏ type to search");

    input.send("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    // Back on the menu.
    expect(screen.snapshot()).toContain("▶ Model");

    input.send("\x1b");
    await expect(answer).resolves.toBeUndefined();
    renderer.setupFlow.end({ preserveDiagnostics: false });
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

  it("uses the attention color for an external-action pulse", () => {
    const { screen, renderer } = makeRenderer();

    renderer.setupFlow.begin("Agent connections", "pulse");
    renderer.setupFlow.setStatus({
      kind: "external-action",
      text: "Waiting for you to complete setup in the browser…",
      emphasis: "browser",
    });

    expect(screen.rawOutput()).toContain("\x1b[33m▪\x1b[39m");
    expect(screen.rawOutput()).toContain("\x1b[33mbrowser\x1b[39m");
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
    // Focused completed row reads inert: a dim pointer, not a check.
    expect(snapshot).toContain("▷ Terminal UI · Already installed");
    expect(snapshot).not.toContain("✓ Terminal UI");
    expect(snapshot).toContain("✓ Web Chat");
    expect(snapshot).toContain("Slack       · Creates slackbot and deploys to Vercel");
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
    const echoIndex = lines.findIndex((line) => line.includes("│ /channels"));
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
    expect(promptLine?.startsWith("❯ /")).toBe(true);

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

    expect(screen.snapshot()).toContain("│ /channels");
    expect(screen.snapshot()).not.toContain("❯ /channels");
  });

  it("submits an alias as typed instead of canonicalizing it", async () => {
    const { screen, input, renderer } = makeRenderer();

    const prompt = renderer.readPrompt();
    input.type("/quit");
    input.enter();
    expect(await prompt).toBe("/quit");
    renderer.shutdown();

    expect(screen.snapshot()).toContain("│ /quit");
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

    const prompt = renderer.readPrompt();
    input.type("/");
    const snapshot = screen.snapshot();
    expect(snapshot).toContain("Authenticate with Vercel");
    expect(snapshot).not.toContain("Configure the agent's model and provider");
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

    const prompt = renderer.readPrompt();
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
    pendingDeploy: false,
  };

  it("renders the local server, model, and Vercel link under the prompt row", async () => {
    const { screen, input, renderer } = makeRenderer();
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("anthropic/claude-sonnet-5", {
        kind: "gateway",
        connected: false,
      }),
    });

    const prompt = renderer.readPrompt();
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
    const promptRow = lines.findIndex((line) => line.includes("›"));
    expect(promptRow).toBeGreaterThan(-1);
    const statusRow = lines.slice(promptRow + 1).join("\n");
    expect(statusRow).toContain(":3000");
    expect(statusRow).toContain("anthropic/claude-sonnet-5");
    expect(statusRow.indexOf(":3000")).toBeLessThan(statusRow.indexOf("anthropic/claude-sonnet-5"));
    // The linked project folds into the connected gateway label.
    expect(statusRow).toContain("via ai-gateway(oidc:my-agent)");
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
      info: agentInfoWithModel("anthropic/claude-sonnet-5", {
        kind: "gateway",
        connected: true,
        credential: "oidc",
      }),
    });
    renderer.setVercelStatus(vercelStatus);
    expect(screen.snapshot()).toContain("via ai-gateway(oidc:my-agent)");

    renderer.setupFlow.begin("Connect to Vercel");
    expect(screen.snapshot()).not.toContain("via ai-gateway(oidc:my-agent)");

    renderer.setupFlow.end({ preserveDiagnostics: false });
    expect(screen.snapshot()).toContain("via ai-gateway(oidc:my-agent)");
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
    const title = lines.indexOf("   Authenticate via Vercel OIDC");
    expect(lines.slice(title, title + 3)).toEqual([
      "   Authenticate via Vercel OIDC",
      "",
      "   Select your team",
    ]);
    const status = lines.indexOf("   ↗ vpoke.playground-vercel.tools  Authenticating via OIDC…");
    expect(status).toBeGreaterThan(title);
    expect(lines[status - 1]).toBe("");

    input.send("\x1b");
    await expect(answer).resolves.toBeUndefined();
    renderer.setupFlow.end({ preserveDiagnostics: false });
    renderer.shutdown();
  });

  it("keeps the token flow off the status line after a turn reports usage", async () => {
    const { screen, renderer } = makeRenderer();
    await renderer.renderStream(
      streamOf([
        { type: "step-start" },
        { type: "assistant-delta", id: "t1", delta: "Hi." },
        { type: "assistant-complete", id: "t1" },
        { type: "step-finish", usage: { inputTokens: 500, outputTokens: 300 } },
        { type: "finish", usage: { inputTokens: 500, outputTokens: 300 } },
      ]),
      { submittedPrompt: "hello", continueSession: true },
    );

    // Token flow belongs to the end-of-turn coda; the settled footer keeps
    // only the quiet `· Ready` row and its turn-scoped stats.
    const snapshot = screen.snapshot();
    expect(snapshot).not.toContain("↑ 500");
    expect(snapshot).not.toContain("↓ 300");
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

  it("keeps the model and Vercel segments across reset while tokens stay clear", async () => {
    // 100 columns: all four segments fit at full fidelity, no drop order.
    const { screen, renderer } = makeRenderer(100);
    renderer.renderAgentHeader({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: agentInfoWithModel("anthropic/claude-sonnet-5", {
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
    expect(screen.snapshot()).not.toContain("↑ 500 ↓ 300");

    renderer.reset();

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("anthropic/claude-sonnet-5");
    expect(snapshot).toContain("via ai-gateway(oidc:my-agent)");
    expect(snapshot).toContain("/deploy pending");
    // A fresh conversation clears the token flow entirely (↑ 0 ↓ 0 is noise).
    expect(snapshot).not.toContain("↑ 0");
    expect(snapshot).not.toContain("↑ 500");
    expect(snapshot).not.toContain("hello");
    renderer.shutdown();
  });
});

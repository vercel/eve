import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Client,
  MessageResponse,
  type AgentInfoResult,
  type ClientSession,
  type HandleMessageStreamEvent,
} from "#client/index.js";

import {
  EveTUIRunner,
  parsePromptCommand,
  type AgentTUIAgentHeader,
  type AgentTUIRenderer,
  type AgentTUISessionOptions,
  type AgentTUIStreamEvent,
  type PromptCommandOutcome,
} from "./runner.js";
import { createPromptCommandHandler } from "./prompt-command-handler.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";

/**
 * Real `Client` whose network-touching methods are replaced by vi spies.
 * Keeps the runner's option types honest (no double casts) while still
 * never hitting the wire.
 */
function stubClient(): Client {
  return new Client({ host: "http://localhost:3000" });
}

/** Real `ClientSession` handle; harmless until `send`/`stream` are spied. */
function stubSession(): ClientSession {
  return stubClient().session();
}

/** Wraps literal stream events in a real `MessageResponse`. */
function messageResponseOf(events: readonly unknown[]): MessageResponse {
  return new MessageResponse({
    continuationToken: "eve:test",
    createStream: async function* () {
      for (const event of events) yield event as HandleMessageStreamEvent;
    },
    sessionId: "session_test",
  });
}

const AGENT_INFO: AgentInfoResult = {
  agent: {
    agentRoot: "/tmp/weather-agent/agent",
    appRoot: "/tmp/weather-agent",
    model: {
      id: "gpt-5",
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
    static: {
      logicalPath: "agent/instructions.md",
      markdown: "You are a weather assistant.",
      name: "instructions",
      sourceKind: "markdown",
    },
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
    authored: [
      {
        description: "Get the weather.",
        hasAuth: false,
        hasExecute: true,
        hasModelOutputProjection: false,
        hasOutputSchema: false,
        inputSchema: { type: "object" },
        logicalPath: "agent/tools/get_weather.ts",
        name: "get_weather",
        origin: "authored",
        outputSchema: null,
        replacesFrameworkTool: false,
        requiresApproval: false,
        sourceKind: "module",
      },
    ],
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parsePromptCommand", () => {
  it("parses /model with a provider/model slug", () => {
    expect(parsePromptCommand("/model anthropic/claude-opus-4.6")).toEqual({
      type: "extension",
      name: "model",
      argument: "anthropic/claude-opus-4.6",
    });
  });

  it("trims whitespace around the command and slug", () => {
    expect(parsePromptCommand("  /model   anthropic/claude-opus-4.6  ")).toEqual({
      type: "extension",
      name: "model",
      argument: "anthropic/claude-opus-4.6",
    });
  });

  it("parses bare /model as an empty slug", () => {
    expect(parsePromptCommand("/model")).toEqual({
      type: "extension",
      name: "model",
      argument: "",
    });
  });

  it("recognizes /new, /exit, and /quit", () => {
    expect(parsePromptCommand("/new")).toEqual({ type: "new" });
    expect(parsePromptCommand("/exit")).toEqual({ type: "exit" });
    expect(parsePromptCommand("/quit")).toEqual({ type: "exit" });
  });

  it("does not match near-misses or normal messages", () => {
    expect(parsePromptCommand("hello")).toBeNull();
    expect(parsePromptCommand("/models")).toBeNull();
    expect(parsePromptCommand("what does /model do?")).toBeNull();
  });
});

function fakeRenderer(overrides: Partial<AgentTUIRenderer> = {}): AgentTUIRenderer {
  return {
    renderStream: vi.fn(async () => {}),
    readPrompt: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("EveTUIRunner agent header", () => {
  it("reports the paint boundary before rendering the startup header", async () => {
    const order: string[] = [];
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const runner = new EveTUIRunner({
      session: stubSession(),
      client,
      renderer: fakeRenderer({
        renderAgentHeader: () => order.push("render"),
      }),
      serverUrl: "http://localhost:3000",
      onBootProgress: (event) => order.push(event.type),
    });

    await runner.run();

    expect(order).toEqual(["phase-started", "phase-finished", "before-first-paint", "render"]);
  });

  it("fetches agent info and renders the startup header", async () => {
    const headers: AgentTUIAgentHeader[] = [];
    const renderer = fakeRenderer({
      renderAgentHeader: (header) => headers.push(header),
    });
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);

    const runner = new EveTUIRunner({
      session: stubSession(),
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    await runner.run();

    expect(headers).toHaveLength(1);
    expect(headers[0]).toEqual({
      name: "Weather Agent",
      serverUrl: "http://localhost:3000",
      info: AGENT_INFO,
    });
    expect(renderer.readPrompt).toHaveBeenCalled();
  });

  it("still renders a header when info cannot be fetched", async () => {
    const headers: AgentTUIAgentHeader[] = [];
    const renderer = fakeRenderer({
      renderAgentHeader: (header) => headers.push(header),
    });
    const client = stubClient();
    vi.spyOn(client, "info").mockRejectedValue(new Error("unauthorized"));

    const runner = new EveTUIRunner({
      session: stubSession(),
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    await runner.run();

    expect(headers).toHaveLength(1);
    expect(headers[0]?.info).toBeUndefined();
    expect(headers[0]?.name).toBe("Weather Agent");
  });

  it("refreshes the agent header when a dev artifact refresh changes the model", async () => {
    const headers: AgentTUIAgentHeader[] = [];
    const prompts: Array<string | undefined> = ["first", "second", undefined];
    const nextInfo: AgentInfoResult = {
      ...AGENT_INFO,
      agent: {
        ...AGENT_INFO.agent,
        model: {
          id: "anthropic/claude-sonnet-4.6",
        },
      },
    };
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValueOnce(AGENT_INFO).mockResolvedValueOnce(nextInfo);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const revision = prompts.length >= 2 ? "snapshot-a" : "snapshot-b";
        return Response.json({ revision });
      }),
    );

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderAgentHeader: (header) => headers.push(header),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
    };
    const session = sessionYielding([{ type: "session.waiting" }]);

    const runner = new EveTUIRunner({
      session,
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    await runner.run();

    expect(headers).toHaveLength(2);
    expect(headers[0]?.info?.agent.model.id).toBe("gpt-5");
    expect(headers[1]?.info?.agent.model.id).toBe("anthropic/claude-sonnet-4.6");
    expect(client.info).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenCalledTimes(2);
  });

  it("refreshes the agent header while waiting for prompt input", async () => {
    vi.useFakeTimers();
    const headers: AgentTUIAgentHeader[] = [];
    const prompt = createDeferred<string | undefined>();
    const nextInfo: AgentInfoResult = {
      ...AGENT_INFO,
      agent: {
        ...AGENT_INFO.agent,
        model: {
          id: "anthropic/claude-sonnet-4.6",
        },
      },
    };
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValueOnce(AGENT_INFO).mockResolvedValueOnce(nextInfo);
    const revisions = ["snapshot-a", "snapshot-b"];
    const fetchMock = vi.fn(async () =>
      Response.json({ revision: revisions.shift() ?? "snapshot-b" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => await prompt.promise),
      renderAgentHeader: (header) => headers.push(header),
      renderStream: vi.fn(async () => {}),
    };
    const session = sessionYielding([{ type: "session.waiting" }]);

    const runner = new EveTUIRunner({
      session,
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    const run = runner.run();
    await settleAsyncWork();
    expect(headers).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    await settleAsyncWork();

    expect(headers).toHaveLength(2);
    expect(headers[1]?.info?.agent.model.id).toBe("anthropic/claude-sonnet-4.6");
    expect(session.send).not.toHaveBeenCalled();

    prompt.resolve(undefined);
    await run;
  });

  it("waits for an in-flight idle refresh before sending a prompt", async () => {
    vi.useFakeTimers();
    const prompt = createDeferred<string | undefined>();
    const revisionResponse = createDeferred<Response>();
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await revisionResponse.promise),
    );
    const session = sessionYielding([{ type: "session.waiting" }]);
    const prompts: Array<Promise<string | undefined> | string | undefined> = [
      prompt.promise,
      undefined,
    ];

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => await prompts.shift()),
      renderAgentHeader: vi.fn(),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
    };

    const runner = new EveTUIRunner({
      session,
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    const run = runner.run();
    await settleAsyncWork();
    prompt.resolve("hello");
    await settleAsyncWork();

    expect(session.send).not.toHaveBeenCalled();

    revisionResponse.resolve(Response.json({ revision: "snapshot-a" }));
    await run;

    expect(session.send).toHaveBeenCalledTimes(1);
  });
});

function sessionYielding(events: readonly unknown[]): ClientSession {
  const session = stubSession();
  vi.spyOn(session, "send").mockImplementation(async () => messageResponseOf(events));
  return session;
}

function sessionYieldingTurns(turns: ReadonlyArray<readonly unknown[]>): ClientSession {
  const session = stubSession();
  let index = 0;
  vi.spyOn(session, "send").mockImplementation(async () => {
    const events = turns[index] ?? [];
    index += 1;
    return messageResponseOf(events);
  });
  return session;
}

describe("EveTUIRunner terminal-failure recovery", () => {
  it("starts a fresh session and posts a notice after session.failed", async () => {
    const notices: string[] = [];
    const prompts: Array<string | undefined> = ["what else can you do", undefined];

    const failingSession = sessionYielding([
      {
        type: "session.failed",
        data: { code: "HookConflictError", message: "HookConflictError: token in use" },
      },
    ]);
    const recoveredSession = sessionYielding([]);
    const client = stubClient();
    const sessionFactory = vi.spyOn(client, "session").mockImplementation(() => recoveredSession);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderNotice: (text) => notices.push(text),
      renderStream: vi.fn(async (result) => {
        // Draining the stream runs the event translator, which fires the
        // runner's terminal-failure hook on `session.failed`.
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
    };

    const runner = new EveTUIRunner({
      session: failingSession,
      client,
      renderer,
      name: "Weather Agent",
    });

    await runner.run();

    // Exactly one recovery session was created, and the failed session was
    // only used for the one (failing) turn.
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(failingSession.send).toHaveBeenCalledTimes(1);
    expect(recoveredSession.send).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("new session");
  });
});

describe("EveTUIRunner delayed dev build errors", () => {
  it("flushes delayed dev build errors before dispatching a user prompt", async () => {
    const calls: string[] = [];
    const prompts: Array<string | undefined> = ["hello", undefined];
    const session = stubSession();
    vi.spyOn(session, "send").mockImplementation(async () => {
      calls.push("send");
      return messageResponseOf([{ type: "session.waiting" }]);
    });
    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      flushDelayedDevBuildErrors: vi.fn(() => {
        calls.push("flush");
      }),
      renderStream: vi.fn(async () => {}),
    };

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });

    await runner.run();

    expect(calls).toEqual(["flush", "send"]);
    expect(renderer.flushDelayedDevBuildErrors).toHaveBeenCalledTimes(1);
  });

  it("does not flush delayed dev build errors for local slash commands", async () => {
    const prompts: Array<string | undefined> = ["/help", undefined];
    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      flushDelayedDevBuildErrors: vi.fn(),
      renderNotice: vi.fn(),
      renderStream: vi.fn(async () => {}),
    };

    const runner = new EveTUIRunner({
      session: sessionYielding([{ type: "session.waiting" }]),
      renderer,
      name: "Weather Agent",
    });

    await runner.run();

    expect(renderer.flushDelayedDevBuildErrors).not.toHaveBeenCalled();
  });
});

describe("EveTUIRunner initial input", () => {
  it("seeds only the first prompt's editable buffer with --input text", async () => {
    const seenOptions: Array<AgentTUISessionOptions | undefined> = [];
    const prompts: Array<string | undefined> = ["edited and sent", undefined];
    const session = sessionYielding([{ type: "session.waiting" }]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async (options?: AgentTUISessionOptions) => {
        seenOptions.push(options);
        return prompts.shift();
      }),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
    };

    const runner = new EveTUIRunner({
      session,
      renderer,
      name: "Weather Agent",
      initialInput: "draft me",
    });

    await runner.run();

    expect(seenOptions[0]?.initialDraft).toBe("draft me");
    expect(seenOptions[1]?.initialDraft).toBeUndefined();
    // The seed is a draft, not an auto-submit: the turn carries the text the
    // user actually sent, not the seeded value.
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenNthCalledWith(1, {
      message: "edited and sent",
      signal: expect.any(AbortSignal),
    });
  });
});

describe("EveTUIRunner native continuation state", () => {
  it("continues an input request from eve-native turn state", async () => {
    const prompts: Array<string | undefined> = ["approve this", undefined];
    const session = sessionYieldingTurns([
      [
        {
          type: "input.requested",
          data: {
            requests: [
              {
                action: {
                  callId: "call-1",
                  input: { city: "SF" },
                  kind: "tool-call",
                  toolName: "get_weather",
                },
                display: "confirmation",
                options: [
                  { id: "approve", label: "Approve" },
                  { id: "deny", label: "Deny" },
                ],
                prompt: "Approve get_weather?",
                requestId: "request-1",
              },
            ],
          },
        },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ],
      [{ type: "session.waiting", data: { wait: "next-user-message" } }],
    ]);
    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      readToolApproval: vi.fn(async () => ({ approved: true })),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
    };

    const runner = new EveTUIRunner({
      session,
      renderer,
      name: "Weather Agent",
    });

    await runner.run();

    expect(session.send).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenNthCalledWith(1, {
      message: "approve this",
      signal: expect.any(AbortSignal),
    });
    expect(session.send).toHaveBeenNthCalledWith(2, {
      inputResponses: [{ requestId: "request-1", optionId: "approve" }],
      signal: expect.any(AbortSignal),
    });
  });
});

describe("EveTUIRunner failure rendering", () => {
  it("renders one error block for a step/turn/session failure cascade", async () => {
    const prompts: Array<string | undefined> = ["hello", undefined];
    const emitted: AgentTUIStreamEvent[] = [];
    const failureData = {
      code: "MODEL_CALL_FAILED",
      message: "model call failed terminally",
      details: {
        errorId: "err-1",
        message: "model call failed terminally",
        detail: "Error: model call failed terminally\n    at turn (harness/tool-loop.ts:1:1)",
      },
    };
    const session = sessionYielding([
      { type: "step.failed", data: { ...failureData, sequence: 0, stepIndex: 0, turnId: "t0" } },
      { type: "turn.failed", data: { ...failureData, sequence: 0, turnId: "t0" } },
      { type: "session.failed", data: { ...failureData, sessionId: "s0" } },
    ]);
    const client = stubClient();
    vi.spyOn(client, "session").mockImplementation(() => sessionYielding([]));

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderNotice: vi.fn(),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<AgentTUIStreamEvent>) {
          emitted.push(event);
        }
      }),
    };

    const runner = new EveTUIRunner({ session, client, renderer, name: "Weather Agent" });
    await runner.run();

    const errors = emitted.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      errorText: "MODEL_CALL_FAILED: model call failed terminally",
      detail: "Error: model call failed terminally\n    at turn (harness/tool-loop.ts:1:1)",
    });
  });

  it("omits detail when the failure carries only a curated summary", async () => {
    const prompts: Array<string | undefined> = ["hello", undefined];
    const emitted: AgentTUIStreamEvent[] = [];
    const session = sessionYielding([
      {
        type: "turn.failed",
        data: {
          code: "MODEL_CALL_FAILED",
          message: "MODEL_CALL_FAILED: bad gateway key",
          details: { errorId: "err-2", message: "bad gateway key", name: "GatewayError" },
          sequence: 0,
          turnId: "t0",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<AgentTUIStreamEvent>) {
          emitted.push(event);
        }
      }),
    };

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    const errors = emitted.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    // The message already carries its own code prefix — no "Code: Code:".
    expect(errors[0]).toEqual({
      type: "error",
      errorText: "MODEL_CALL_FAILED: bad gateway key",
    });
  });
});

describe("EveTUIRunner reused step indexes", () => {
  it("renders the post-subagent message that the harness emits under a reused stepIndex", async () => {
    // Mirrors the real parent stream around a subagent dispatch: the second
    // model call arrives under a fresh `step.started` but the SAME
    // `turnId:stepIndex` key as the already-completed first message. It must
    // render as its own assistant block, not be dropped as a replay.
    const prompts: Array<string | undefined> = ["delegate to the subagent", undefined];
    const emitted: AgentTUIStreamEvent[] = [];
    const session = sessionYielding([
      { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" } },
      {
        type: "message.appended",
        data: {
          messageDelta: "I'll call the subagent.",
          messageSoFar: "I'll call the subagent.",
          sequence: 0,
          stepIndex: 0,
          turnId: "t0",
        },
      },
      {
        type: "message.completed",
        data: {
          finishReason: "tool-calls",
          message: "I'll call the subagent.",
          sequence: 0,
          stepIndex: 0,
          turnId: "t0",
        },
      },
      { type: "step.completed", data: { sequence: 0, stepIndex: 0, turnId: "t0", usage: {} } },
      { type: "step.started", data: { sequence: 0, stepIndex: 0, turnId: "t0" } },
      {
        type: "message.appended",
        data: {
          messageDelta: "The subagent returned TOKEN-123.",
          messageSoFar: "The subagent returned TOKEN-123.",
          sequence: 0,
          stepIndex: 0,
          turnId: "t0",
        },
      },
      {
        type: "message.completed",
        data: {
          finishReason: "stop",
          message: "The subagent returned TOKEN-123.",
          sequence: 0,
          stepIndex: 0,
          turnId: "t0",
        },
      },
      { type: "turn.completed", data: { sequence: 0, turnId: "t0" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<AgentTUIStreamEvent>) {
          emitted.push(event);
        }
      }),
    };

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    const deltas = emitted.filter((event) => event.type === "assistant-delta");
    expect(deltas).toHaveLength(2);
    // Distinct block ids — the second message is its own generation/block.
    expect(deltas[0]?.id).not.toBe(deltas[1]?.id);
    expect(deltas[0]?.delta).toBe("I'll call the subagent.");
    expect(deltas[1]?.delta).toBe("The subagent returned TOKEN-123.");
    const completes = emitted.filter((event) => event.type === "assistant-complete");
    expect(completes).toHaveLength(2);
  });
});

describe("EveTUIRunner replay guards", () => {
  it("ignores replayed tool batches and divergent text attempts in one turn", async () => {
    const prompts: Array<string | undefined> = ["weather", undefined];
    const emitted: AgentTUIStreamEvent[] = [];
    const session = sessionYielding([
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call-original",
              input: { city: "New York" },
              kind: "tool-call",
              toolName: "get_weather",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call-original",
              input: { city: "New York" },
              kind: "tool-call",
              toolName: "get_weather",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "action.result",
        data: {
          result: {
            callId: "call-original",
            kind: "tool-result",
            output: "Sunny in New York",
          },
          sequence: 0,
          status: "completed",
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call-replay",
              input: { city: "New York" },
              kind: "tool-call",
              toolName: "get_weather",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "action.result",
        data: {
          result: {
            callId: "call-replay",
            kind: "tool-result",
            output: "Sunny in New York",
          },
          sequence: 0,
          status: "completed",
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "message.appended",
        data: {
          messageDelta: "Using",
          messageSoFar: "Using",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_0",
        },
      },
      {
        type: "message.appended",
        data: {
          messageDelta: " the first",
          messageSoFar: "Using the first",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_0",
        },
      },
      {
        type: "message.appended",
        data: {
          messageDelta: " the retry",
          messageSoFar: "Using the retry",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_0",
        },
      },
      {
        type: "message.completed",
        data: {
          finishReason: "stop",
          message: "Using the first answer.",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_0",
        },
      },
      {
        type: "message.appended",
        data: {
          messageDelta: " answer.",
          messageSoFar: "Using the retry answer.",
          sequence: 0,
          stepIndex: 1,
          turnId: "turn_0",
        },
      },
      {
        type: "turn.completed",
        data: {
          sequence: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call-post-turn",
              input: { city: "New York" },
              kind: "tool-call",
              toolName: "get_weather",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<AgentTUIStreamEvent>) {
          emitted.push(event);
        }
      }),
    };

    const runner = new EveTUIRunner({
      session,
      renderer,
      name: "Weather Agent",
    });

    await runner.run();

    const toolCalls = emitted.filter((event) => event.type === "tool-call");
    const toolResults = emitted.filter((event) => event.type === "tool-result");
    const assistantText = emitted
      .filter((event) => event.type === "assistant-delta")
      .map((event) => event.delta)
      .join("");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolCallId: "call-original" });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ toolCallId: "call-original" });
    expect(assistantText).toBe("Using the first answer.");
    expect(assistantText).not.toContain("retry");
    expect(emitted.filter((event) => event.type === "finish")).toHaveLength(1);
  });

  it("renders a known tool result that arrives after turn.completed", async () => {
    const prompts: Array<string | undefined> = ["weather", undefined];
    const emitted: AgentTUIStreamEvent[] = [];
    const session = sessionYielding([
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call-late",
              input: { command: "find /workspace -type f | sort" },
              kind: "tool-call",
              toolName: "bash",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "turn.completed",
        data: {
          sequence: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "action.result",
        data: {
          result: {
            callId: "call-late",
            kind: "tool-result",
            output: { exitCode: 0, stderr: "", stdout: "/workspace/weather-codes.md\n" },
          },
          sequence: 0,
          status: "completed",
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<AgentTUIStreamEvent>) {
          emitted.push(event);
        }
      }),
    };

    const runner = new EveTUIRunner({
      session,
      renderer,
      name: "Weather Agent",
    });

    await runner.run();

    expect(emitted.filter((event) => event.type === "tool-call")).toHaveLength(1);
    expect(emitted.filter((event) => event.type === "tool-result")).toEqual([
      {
        output: { exitCode: 0, stderr: "", stdout: "/workspace/weather-codes.md\n" },
        toolCallId: "call-late",
        type: "tool-result",
      },
    ]);
  });
});

describe("parsePromptCommand", () => {
  it.each([
    ["/new", { type: "new" }],
    ["/exit", { type: "exit" }],
    ["/quit", { type: "exit" }],
    ["/channels", { type: "extension", name: "channels", argument: "" }],
    ["/deploy", { type: "extension", name: "deploy", argument: "" }],
    ["  /channels  ", { type: "extension", name: "channels", argument: "" }],
    ["/vercel", null],
    ["/links", null],
    ["deploy", null],
    ["tell me about /channels", null],
  ] as const)("parses %j as %j", (prompt, expected) => {
    expect(parsePromptCommand(prompt)).toEqual(expected);
  });
});

describe("EveTUIRunner setup commands", () => {
  function recordingRenderer(prompts: Array<string | undefined>) {
    const notices: string[] = [];
    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderNotice: (text) => notices.push(text),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
    };
    return { renderer, notices };
  }

  it("answers /channels with a local-only notice when no appRoot is configured", async () => {
    const session = sessionYielding([]);
    const { renderer, notices } = recordingRenderer(["/channels", undefined]);

    const runner = new EveTUIRunner({
      session,
      renderer,
      name: "Weather Agent",
      promptCommandHandler: createPromptCommandHandler({}),
    });
    await runner.run();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("--url");
    expect(session.send).not.toHaveBeenCalled();
  });

  it("answers /deploy with an unsupported notice when the renderer cannot suspend", async () => {
    const session = sessionYielding([]);
    const { renderer, notices } = recordingRenderer(["/deploy", undefined]);

    const runner = new EveTUIRunner({
      session,
      renderer,
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      promptCommandHandler: createPromptCommandHandler({ appRoot: "/tmp/weather-agent" }),
    });
    await runner.run();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("not supported by this renderer");
    expect(session.send).not.toHaveBeenCalled();
  });
});

describe("EveTUIRunner renderer teardown", () => {
  it("shuts the renderer down when the run loop exits with an error", async () => {
    // The terminal renderer's shutdown restores the captured stdout/stderr
    // writes; without it a fatal error would be reported into the capture
    // and the process would die silently.
    const shutdown = vi.fn();
    const session = sessionYielding([]);
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => "hello"),
      renderStream: vi.fn(async () => {
        throw new Error("renderer exploded");
      }),
      shutdown,
    });

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });

    await expect(runner.run()).rejects.toThrow("renderer exploded");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("propagates command-handler errors after restoring the renderer", async () => {
    const shutdown = vi.fn();
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => "/model"),
      shutdown,
    });
    const runner = new EveTUIRunner({
      session: sessionYielding([]),
      renderer,
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      promptCommandHandler: {
        handle: async () => {
          throw new Error("command implementation failed");
        },
      },
    });

    await expect(runner.run()).rejects.toThrow("command implementation failed");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("shuts the renderer down once when /exit ends the run loop", async () => {
    const shutdown = vi.fn();
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => "/exit"),
      shutdown,
    });
    const runner = new EveTUIRunner({
      session: sessionYielding([]),
      renderer,
      name: "Weather Agent",
    });

    await runner.run();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("EveTUIRunner Vercel status line", () => {
  const identity = { projectName: "my-agent", teamName: "acme" };

  it("probes the link identity at startup and pushes it to the renderer", async () => {
    const pushes: VercelStatusSnapshot[] = [];
    const firstPush = createDeferred<void>();
    const detectIdentity = vi.fn(async () => identity);
    const renderer = fakeRenderer({
      // Hold the prompt open until the async probe lands, so the run loop
      // cannot exit (and dispose the tracker) before the push arrives.
      readPrompt: vi.fn(async () => {
        await firstPush.promise;
        return undefined;
      }),
      setVercelStatus: (snapshot) => {
        pushes.push(snapshot);
        firstPush.resolve();
      },
    });

    const runner = new EveTUIRunner({
      session: stubSession(),
      renderer,
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      detectProjectIdentity: detectIdentity,
    });
    await runner.run();

    expect(pushes).toEqual([{ identity, pendingDeploy: false }]);
    expect(detectIdentity).toHaveBeenCalledWith("/tmp/weather-agent");
  });

  it("applies command effects: channels mark pending, deploy clears and re-probes", async () => {
    const pushes: VercelStatusSnapshot[] = [];
    const settled = createDeferred<void>();
    let probes = 0;
    // The startup probe never resolves; only the post-deploy re-probe lands,
    // which keeps the push order deterministic.
    const detectIdentity = vi.fn(() => {
      probes += 1;
      return probes === 1 ? new Promise<never>(() => {}) : Promise.resolve(identity);
    });
    const prompts: Array<string | undefined> = ["/channels", "/deploy"];
    const renderer = fakeRenderer({
      renderNotice: vi.fn(),
      readPrompt: vi.fn(async () => {
        const next = prompts.shift();
        if (next !== undefined) return next;
        await settled.promise;
        return undefined;
      }),
      setVercelStatus: (snapshot) => {
        pushes.push(snapshot);
        if (pushes.length >= 3) settled.resolve();
      },
    });
    const outcomes: Record<string, PromptCommandOutcome> = {
      channels: {
        message: "Channels added: slack — run /deploy to ship them.",
        vercelEffect: { kind: "channels-added" },
      },
      deploy: { message: "Deployed.", vercelEffect: { kind: "deployed" } },
    };

    const runner = new EveTUIRunner({
      session: stubSession(),
      renderer,
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      detectProjectIdentity: detectIdentity,
      promptCommandHandler: { handle: async (command) => outcomes[command.name] },
    });
    await runner.run();

    expect(pushes).toEqual([
      { pendingDeploy: true },
      { pendingDeploy: false },
      { identity, pendingDeploy: false },
    ]);
    expect(detectIdentity).toHaveBeenCalledTimes(2);
  });

  it("never pushes Vercel status for a remote --url session", async () => {
    const setVercelStatus = vi.fn();
    const renderer = fakeRenderer({ setVercelStatus });

    const runner = new EveTUIRunner({
      session: stubSession(),
      renderer,
      name: "Weather Agent",
    });
    await runner.run();

    expect(setVercelStatus).not.toHaveBeenCalled();
  });
});

describe("EveTUIRunner gateway-auth failure rendering", () => {
  const gatewayFailure = {
    code: "MODEL_CALL_FAILED",
    message: "AI Gateway received no credentials. Run `eve link` to populate…",
    details: {
      errorId: "err-1",
      name: "AI Gateway authentication failed",
      gatewayName: "GatewayAuthenticationError",
    },
  };

  async function errorTextsFor(appRoot?: string): Promise<string[]> {
    const prompts: Array<string | undefined> = ["hello", undefined];
    const emitted: AgentTUIStreamEvent[] = [];
    const session = sessionYielding([
      { type: "step.failed", data: { ...gatewayFailure, sequence: 0, stepIndex: 0, turnId: "t0" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderNotice: vi.fn(),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<AgentTUIStreamEvent>) {
          emitted.push(event);
        }
      }),
    };

    const options: ConstructorParameters<typeof EveTUIRunner>[0] = {
      session,
      renderer,
      name: "Weather Agent",
    };
    if (appRoot !== undefined) options.appRoot = appRoot;
    const runner = new EveTUIRunner(options);
    await runner.run();

    return emitted
      .filter((event) => event.type === "error")
      .map((event) => (event as { errorText: string }).errorText);
  }

  it("collapses the failure to the minimal /model line when setup commands are available", async () => {
    const errors = await errorTextsFor("/tmp/weather-agent");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      "There is no AI_GATEWAY_API_KEY set. Run /model to connect this to a project and refresh AI Gateway credentials, or set it manually in .env.local.",
    );
  });

  it("keeps the full failure message when the TUI has no local project to link", async () => {
    const errors = await errorTextsFor(undefined);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("MODEL_CALL_FAILED");
    expect(errors[0]).not.toContain("/model");
  });
});

describe("EveTUIRunner boot setup detection", () => {
  function bootRunner(input: {
    appRoot?: string;
    issues: Array<{ label: string; command: string }>;
  }) {
    const warnings: string[] = [];
    const session = sessionYielding([]);
    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => undefined),
      renderSetupWarning: (text) => warnings.push(text),
      renderStream: vi.fn(async () => {}),
    };
    const options: ConstructorParameters<typeof EveTUIRunner>[0] = {
      session,
      renderer,
      name: "Weather Agent",
      bootDetections: [{ id: "test", detect: () => input.issues }],
    };
    if (input.appRoot !== undefined) options.appRoot = input.appRoot;
    return { runner: new EveTUIRunner(options), warnings };
  }

  it("surfaces detected issues as the attention line at boot", async () => {
    const { runner, warnings } = bootRunner({
      appRoot: "/tmp/weather-agent",
      issues: [{ label: "AI Gateway credentials", command: "/model" }],
    });
    await runner.run();

    expect(warnings).toEqual(["1 setup issue: AI Gateway credentials · /model"]);
  });

  it("stays quiet without a local setup context, even with issues", async () => {
    const { runner, warnings } = bootRunner({
      issues: [{ label: "AI Gateway credentials", command: "/model" }],
    });
    await runner.run();

    expect(warnings).toEqual([]);
  });

  it("stays quiet when detection finds nothing", async () => {
    const { runner, warnings } = bootRunner({
      appRoot: "/tmp/weather-agent",
      issues: [],
    });
    await runner.run();

    expect(warnings).toEqual([]);
  });
});

describe("EveTUIRunner command outcome rendering", () => {
  it("answers /help with the command table even without a command handler", async () => {
    const results: string[] = [];
    const prompts: Array<string | undefined> = ["/help", undefined];
    const session = sessionYielding([]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderNotice: vi.fn(),
      renderCommandResult: (text) => results.push(text),
      renderStream: vi.fn(async () => {}),
    };

    const runner = new EveTUIRunner({
      session,
      renderer,
      name: "Weather Agent",
    });
    await runner.run();

    expect(results).toHaveLength(1);
    expect(results[0]).toContain("/model");
    expect(results[0]).toContain("/channels");
    expect(session.send).not.toHaveBeenCalled();
  });

  it("dispatches /loglevel to the renderer and reports the outcome", async () => {
    const results: string[] = [];
    const modes: string[] = [];
    const prompts: Array<string | undefined> = [
      "/loglevel none",
      "/loglevel bogus",
      "/loglevel sandbox",
      undefined,
    ];
    const session = sessionYielding([]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderCommandResult: (text) => results.push(text),
      renderStream: vi.fn(async () => {}),
      logDisplayMode: () => "all",
      setLogDisplayMode: (mode) => modes.push(mode),
    };

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    expect(modes).toEqual(["none", "sandbox"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toContain("hidden");
    expect(results[1]).toContain('Unknown log level "bogus"');
    expect(results[2]).toContain("sandbox");
    expect(session.send).not.toHaveBeenCalled();
  });

  it("reports /loglevel as unavailable when the renderer cannot toggle logs", async () => {
    const results: string[] = [];
    const prompts: Array<string | undefined> = ["/loglevel none", undefined];
    const session = sessionYielding([]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderCommandResult: (text) => results.push(text),
      renderStream: vi.fn(async () => {}),
    };

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    expect(results).toEqual(["/loglevel is not available in this session."]);
    expect(session.send).not.toHaveBeenCalled();
  });

  it("prefers the elbow-styled command result over a plain notice", async () => {
    const notices: string[] = [];
    const results: string[] = [];
    const prompts: Array<string | undefined> = ["/deploy", undefined];
    const session = sessionYielding([]);

    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      renderNotice: (text) => notices.push(text),
      renderCommandResult: (text) => results.push(text),
      renderStream: vi.fn(async () => {}),
    };

    const runner = new EveTUIRunner({
      session,
      renderer,
      name: "Weather Agent",
      promptCommandHandler: createPromptCommandHandler({}),
    });
    await runner.run();

    expect(results).toHaveLength(1);
    expect(results[0]).toContain("--url");
    expect(notices).toEqual([]);
  });
});

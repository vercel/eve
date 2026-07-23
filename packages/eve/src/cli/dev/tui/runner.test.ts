import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Client,
  ClientError,
  MessageResponse,
  type AgentInfoResult,
  type ClientSession,
  type HandleMessageStreamEvent,
} from "#client/index.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import type { VercelDeploymentResolution } from "#setup/vercel-deployment.js";

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
import { promptCommandsFor } from "./prompt-commands.js";
import { interruptedError } from "./errors.js";
import type { RemoteAuthFlow } from "./remote-auth.js";
import type { RemoteAuthCompletedMutation } from "./remote-auth-result.js";
import type { RemoteConnectionControllerOptions } from "./remote-connection.js";
import type { BootDetection, SetupIssue } from "./setup-issues.js";
import type { SetupFlowRenderer } from "./setup-flow.js";
import { createFakeSetupFlowRenderer } from "./test/fake-setup-flow-renderer.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";

const REMOTE_VERIFIED_TARGET = await resolveTestVercelTarget({
  host: "vpoke.playground-vercel.tools",
  projectId: "prj_inbound",
  projectName: "inbound",
});
const VERCEL_SSO_URL =
  "https://vercel.com/sso-api?url=https%3A%2F%2Fvpoke.playground-vercel.tools&nonce=test";

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

beforeEach(() => {
  // The runner normalizes header endpoints from the real process.env; a
  // developer shell exporting gateway credentials must not leak into these
  // boot-state assertions.
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

function idleSetupFlow(): SetupFlowRenderer {
  return {
    begin: vi.fn(),
    end: vi.fn(),
    readSelect: vi.fn(async () => undefined),
    readEditableSelect: vi.fn(async () => undefined),
    readProviderPicker: vi.fn(async () => undefined),
    readModelEditor: vi.fn(async () => undefined),
    readText: vi.fn(async () => undefined),
    readAcknowledge: vi.fn(async () => {}),
    readChoice: vi.fn(() => ({ choice: Promise.resolve(undefined), close: vi.fn() })),
    setStatus: vi.fn(),
    renderLine: vi.fn(),
    renderOutput: vi.fn(),
    waitForInterrupt: () => ({
      promise: new Promise<void>(() => {}),
      dispose: vi.fn(),
    }),
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

  it("retries a transient info failure before rendering the startup header", async () => {
    vi.useFakeTimers();
    const headers: AgentTUIAgentHeader[] = [];
    const renderer = fakeRenderer({
      renderAgentHeader: (header) => headers.push(header),
    });
    const client = stubClient();
    vi.spyOn(client, "info")
      .mockRejectedValueOnce(new ClientError(500, "Runner did not become ready in time"))
      .mockResolvedValueOnce(AGENT_INFO);
    const runner = new EveTUIRunner({
      session: stubSession(),
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
    });

    const running = runner.run();
    await settleAsyncWork();
    await vi.advanceTimersByTimeAsync(100);
    await running;

    expect(client.info).toHaveBeenCalledTimes(2);
    expect(headers).toEqual([
      {
        name: "Weather Agent",
        serverUrl: "http://localhost:3000",
        info: AGENT_INFO,
      },
    ]);
  });

  it("refreshes the agent header when a dev artifact refresh changes the model", async () => {
    const headers: AgentTUIAgentHeader[] = [];
    const prompts: Array<string | undefined> = ["first", "second", undefined];
    const nextInfo: AgentInfoResult = {
      ...AGENT_INFO,
      agent: {
        ...AGENT_INFO.agent,
        model: {
          id: "anthropic/claude-sonnet-5",
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
    expect(headers[1]?.info?.agent.model.id).toBe("anthropic/claude-sonnet-5");
    expect(client.info).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenCalledTimes(2);
  });

  it("retries a transient info failure while refreshing the agent header", async () => {
    vi.useFakeTimers();
    const headers: AgentTUIAgentHeader[] = [];
    const prompt = createDeferred<string | undefined>();
    const nextInfo: AgentInfoResult = {
      ...AGENT_INFO,
      agent: {
        ...AGENT_INFO.agent,
        model: {
          id: "anthropic/claude-sonnet-5",
        },
      },
    };
    const client = stubClient();
    vi.spyOn(client, "info")
      .mockResolvedValueOnce(AGENT_INFO)
      .mockRejectedValueOnce(new ClientError(500, "Runner did not become ready in time"))
      .mockResolvedValueOnce(nextInfo);
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
    await vi.advanceTimersByTimeAsync(100);
    await settleAsyncWork();

    expect(headers).toHaveLength(2);
    expect(headers[1]?.info?.agent.model.id).toBe("anthropic/claude-sonnet-5");
    expect(client.info).toHaveBeenCalledTimes(3);
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

describe("EveTUIRunner development session continuity", () => {
  it("keeps the REPL session when HMR publishes a new runtime revision", async () => {
    const requests: Array<{ readonly method: string; readonly url: URL }> = [];
    const revisions = ["revision-a", "revision-a", "revision-b", "revision-b"];
    const encoder = new TextEncoder();
    let nextRevision = 0;
    let nextSession = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        const method = init?.method ?? "GET";
        requests.push({ method, url });

        if (url.pathname.startsWith("/eve/v1/dev/runtime-artifacts")) {
          const revision = revisions[Math.min(nextRevision, revisions.length - 1)] ?? "revision";
          nextRevision += 1;
          return Response.json({ revision });
        }

        if (method === "POST") {
          const sessionId =
            url.pathname === "/eve/v1/session"
              ? `session-${String(++nextSession)}`
              : (url.pathname.split("/").at(-1) ?? `session-${String(++nextSession)}`);
          return Response.json({
            continuationToken: `token-${sessionId}`,
            sessionId,
          });
        }

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  '{"type":"session.waiting","data":{"continuationToken":"token-session-1","wait":"next-user-message"}}\n',
                ),
              );
              controller.close();
            },
          }),
        );
      }),
    );

    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const session = client.session();
    const createSession = vi.spyOn(client, "session");
    const prompts: Array<string | undefined> = ["first", "second", undefined];
    const runner = new EveTUIRunner({
      client,
      name: "Weather Agent",
      renderer: {
        readPrompt: vi.fn(async () => prompts.shift()),
        renderStream: vi.fn(async (result) => {
          for await (const event of result.events as AsyncIterable<unknown>) {
            void event;
          }
        }),
      },
      serverUrl: "http://localhost:3000",
      session,
    });

    await runner.run();

    expect(createSession).not.toHaveBeenCalled();
    expect(session.state.sessionId).toBe("session-1");
    expect(
      requests
        .filter(
          (request) =>
            request.method === "POST" && request.url.pathname.startsWith("/eve/v1/session"),
        )
        .map((request) => request.url.pathname),
    ).toEqual(["/eve/v1/session", "/eve/v1/session/session-1"]);
  });

  it("starts a fresh session only after an explicit /new command", async () => {
    const initialSession = sessionYielding([{ type: "session.waiting" }]);
    const newSession = sessionYielding([{ type: "session.waiting" }]);
    const client = stubClient();
    const createSession = vi.spyOn(client, "session").mockReturnValue(newSession);
    const prompts: Array<string | undefined> = ["first", "/new", "second", undefined];
    const runner = new EveTUIRunner({
      client,
      name: "Weather Agent",
      renderer: {
        readPrompt: vi.fn(async () => prompts.shift()),
        renderStream: vi.fn(async (result) => {
          for await (const event of result.events as AsyncIterable<unknown>) {
            void event;
          }
        }),
      },
      session: initialSession,
    });

    await runner.run();

    expect(createSession).toHaveBeenCalledOnce();
    expect(initialSession.send).toHaveBeenCalledOnce();
    expect(newSession.send).toHaveBeenCalledOnce();
  });
});

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

  it("preserves the session and posts a notice when the stream ends without a boundary", async () => {
    const notices: string[] = [];
    const prompts: Array<string | undefined> = ["run something long", undefined];

    const strandedSession = sessionYielding([{ type: "turn.started", data: {} }]);
    const client = stubClient();
    const sessionFactory = vi.spyOn(client, "session");

    const runner = new EveTUIRunner({
      client,
      name: "Weather Agent",
      renderer: {
        readPrompt: vi.fn(async () => prompts.shift()),
        renderNotice: (text) => notices.push(text),
        renderStream: vi.fn(async (result) => {
          for await (const event of result.events as AsyncIterable<unknown>) {
            void event;
          }
        }),
      },
      session: strandedSession,
    });

    await runner.run();

    expect(sessionFactory).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Lost");
    expect(notices[0]).not.toContain("new session");
  });

  it("starts a fresh session when the user interrupts a turn mid-stream", async () => {
    const notices: string[] = [];
    const prompts: Array<string | undefined> = ["run something long", undefined];

    const interruptedSession = sessionYielding([{ type: "turn.started", data: {} }]);
    const replacementSession = sessionYielding([]);
    const client = stubClient();
    const sessionFactory = vi.spyOn(client, "session").mockReturnValue(replacementSession);

    const runner = new EveTUIRunner({
      client,
      name: "Weather Agent",
      renderer: {
        readPrompt: vi.fn(async () => prompts.shift()),
        renderNotice: (text) => notices.push(text),
        renderStream: vi.fn(async (result) => {
          for await (const event of result.events as AsyncIterable<unknown>) {
            void event;
            result.abort?.();
            break;
          }
        }),
      },
      session: interruptedSession,
    });

    await runner.run();

    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("new session");
    expect(notices[0]).toContain("may still be running");
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

describe("EveTUIRunner connection authorization", () => {
  it("continues a parked interactive authorization session until the callback completes", async () => {
    const prompts: Array<string | undefined> = ["connect linear", undefined];
    const updates: Array<{ name: string; state: string }> = [];
    const pendingCounts: number[] = [];
    const session = sessionYielding([
      {
        type: "authorization.required",
        data: {
          authorization: { url: "https://connect.vercel.com/authorize/linear" },
          description: "Authorization required for linear",
          name: "linear",
          webhookUrl: "https://eve.test/connections/linear/callback",
        },
      },
      { type: "session.waiting", data: { wait: "connection-authorization" } },
    ]);
    vi.spyOn(session, "stream").mockImplementation(async function* () {
      yield {
        type: "authorization.completed",
        data: { name: "linear", outcome: "authorized" },
      } as HandleMessageStreamEvent;
      yield {
        type: "session.waiting",
        data: { wait: "next-user-message" },
      } as HandleMessageStreamEvent;
    });
    const renderer: AgentTUIRenderer = {
      readPrompt: vi.fn(async () => prompts.shift()),
      upsertConnectionAuth: (update) => updates.push({ name: update.name, state: update.state }),
      setConnectionAuthPendingCount: (count) => pendingCounts.push(count),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<AgentTUIStreamEvent>) {
          void event;
        }
      }),
    };

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    expect(session.stream).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([
      { name: "linear", state: "required" },
      { name: "linear", state: "pending" },
      { name: "linear", state: "authorized" },
    ]);
    expect(pendingCounts).toEqual([1, 0]);
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
  it("deduplicates repeated call IDs and divergent text attempts in one turn", async () => {
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

    expect(toolCalls.map((event) => event.toolCallId)).toEqual(["call-original", "call-replay"]);
    expect(toolResults.map((event) => event.toolCallId)).toEqual(["call-original", "call-replay"]);
    expect(assistantText).toBe("Using the first answer.");
    expect(assistantText).not.toContain("retry");
    expect(emitted.filter((event) => event.type === "finish")).toHaveLength(1);
  });

  it("renders every call in a 100-way bash fan-out with identical input", async () => {
    const prompts: Array<string | undefined> = ["run the fan-out", undefined];
    const emitted: AgentTUIStreamEvent[] = [];
    const sentence = Array.from({ length: 100 }, (_, index) => `word-${index + 1}`).join(" ");
    const command = `printf '%s\\n' '${sentence}'`;
    const session = sessionYielding([
      ...Array.from({ length: 100 }, (_, index) => ({
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: `bash-${index + 1}`,
              input: { command },
              kind: "tool-call",
              toolName: "bash",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
      })),
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

    const toolCalls = emitted.filter((event) => event.type === "tool-call");
    expect(toolCalls).toHaveLength(100);
    expect(toolCalls.map((event) => event.toolCallId)).toEqual(
      Array.from({ length: 100 }, (_, index) => `bash-${index + 1}`),
    );
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

  it("preserves a rejected action result instead of rendering it as success", async () => {
    const prompts: Array<string | undefined> = ["run the tool", undefined];
    const emitted: AgentTUIStreamEvent[] = [];
    const session = sessionYielding([
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call-rejected",
              input: { command: "rm something" },
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
        type: "action.result",
        data: {
          error: { code: "USER_REJECTED", message: "Denied by user." },
          result: {
            callId: "call-rejected",
            kind: "tool-result",
            output: null,
          },
          sequence: 0,
          status: "rejected",
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

    await new EveTUIRunner({ session, renderer, name: "Weather Agent" }).run();

    expect(emitted.filter((event) => event.type === "tool-result")).toEqual([]);
    expect(emitted.filter((event) => event.type === "tool-rejected")).toEqual([
      {
        type: "tool-rejected",
        toolCallId: "call-rejected",
        reason: "Denied by user.",
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
      availablePromptCommands: promptCommandsFor("remote"),
      promptCommandHandler: createPromptCommandHandler({
        target: {
          kind: "remote",
          workspaceRoot: "/tmp/weather-agent",
          serverUrl: "https://example.com/",
        },
      }),
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
      promptCommandHandler: createPromptCommandHandler({
        target: {
          kind: "local",
          serverUrl: "http://localhost:3000",
          workspaceRoot: "/tmp/weather-agent",
        },
      }),
    });
    await runner.run();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("not supported by this renderer");
    expect(session.send).not.toHaveBeenCalled();
  });
});

describe("EveTUIRunner remote authentication", () => {
  const target = {
    kind: "remote",
    serverUrl: "https://vpoke.playground-vercel.tools",
    workspaceRoot: "/tmp/weather-agent",
  } as const;

  const unresolvedDeployment: VercelDeploymentResolution = {
    kind: "failed",
    failure: {
      cause: "vercel",
      failure: {
        code: null,
        message: "Vercel deployment lookup failed.",
        stderr: "",
        stdout: "",
      },
    },
  };

  function remoteOptions(
    resolveDeployment: NonNullable<
      RemoteConnectionControllerOptions["resolveDeployment"]
    > = async () => unresolvedDeployment,
  ) {
    return {
      target,
      credentials: createDevelopmentCredentialGate(target.serverUrl),
      resolveDeployment,
      resolveOidcToken: async () => ({
        kind: "resolution-failed" as const,
        message: "No ambient token in this test.",
      }),
    };
  }

  function unauthorized(): ClientError {
    return new ClientError(
      401,
      '{"ok":false,"code":"unauthorized","error":"Authorization is required for this route."}',
    );
  }

  function successfulAuth(
    completedMutations: readonly RemoteAuthCompletedMutation[] = [],
  ): RemoteAuthFlow {
    return vi.fn<RemoteAuthFlow>(async () => ({
      kind: "prepared",
      target: REMOTE_VERIFIED_TARGET,
      resolveToken: async () => "fresh-token",
      completedMutations,
    }));
  }

  async function runRemoteAuth(input: {
    client: Client;
    flow: RemoteAuthFlow;
    renderer?: Partial<AgentTUIRenderer>;
    resolveDeployment?: NonNullable<RemoteConnectionControllerOptions["resolveDeployment"]>;
  }): Promise<void> {
    await new EveTUIRunner({
      session: input.client.session(),
      client: input.client,
      renderer: fakeRenderer({ setupFlow: idleSetupFlow(), ...input.renderer }),
      serverUrl: target.serverUrl,
      availablePromptCommands: promptCommandsFor("remote"),
      promptCommandHandler: createPromptCommandHandler({
        target,
        remoteAuthFlow: input.flow,
      }),
      remote: remoteOptions(input.resolveDeployment),
    }).run();
  }

  it("runs /vc:login after an unresolved host returns an authentication challenge", async () => {
    const client = stubClient();
    const order: string[] = [];
    let infoCalls = 0;
    vi.spyOn(client, "info").mockImplementation(async () => {
      order.push("info");
      if (++infoCalls === 1) throw unauthorized();
      return AGENT_INFO;
    });
    const flow = vi.fn<RemoteAuthFlow>(async () => {
      order.push("login");
      return {
        kind: "prepared",
        target: REMOTE_VERIFIED_TARGET,
        resolveToken: async () => "fresh-token",
        completedMutations: [],
      };
    });
    const commandInvocations: Array<{ text: string; status: "failed" | undefined }> = [];

    await runRemoteAuth({
      client,
      flow,
      resolveDeployment: async () => ({ kind: "not-found" }),
      renderer: {
        renderCommandInvocation: (text, status) => commandInvocations.push({ text, status }),
      },
    });

    expect(order).toEqual(["info", "login", "info"]);
    expect(commandInvocations).toEqual([{ text: "/vc:login", status: undefined }]);
  });

  it("runs /vc:login once at startup after Vercel redirects to its SSO challenge", async () => {
    const client = stubClient();
    vi.spyOn(client, "info")
      .mockRejectedValueOnce(new ClientError(302, "Redirecting...", { location: VERCEL_SSO_URL }))
      .mockResolvedValueOnce(AGENT_INFO);
    const commandInvocations: Array<{ text: string; status: "failed" | undefined }> = [];
    const flow = successfulAuth();

    await runRemoteAuth({
      client,
      flow,
      renderer: {
        renderCommandInvocation: (text, status) => commandInvocations.push({ text, status }),
      },
    });

    expect(flow).toHaveBeenCalledOnce();
    expect(flow).toHaveBeenCalledWith(expect.objectContaining({ configureTrustedSources: true }));
    expect(commandInvocations).toEqual([{ text: "/vc:login", status: undefined }]);
  });

  it("requests Trusted Sources repair for an environment mismatch", async () => {
    const client = stubClient();
    const mismatch = new ClientError(
      403,
      "The caller environment is not permitted.\n\n" +
        "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH\n\niad1::request-id",
    );
    vi.spyOn(client, "info").mockRejectedValueOnce(mismatch).mockResolvedValueOnce(AGENT_INFO);
    const flow = successfulAuth();

    await runRemoteAuth({ client, flow });

    expect(flow).toHaveBeenCalledWith(expect.objectContaining({ configureTrustedSources: true }));
  });

  it("renders a failed automatic /vc:login as one command result without the request id", async () => {
    const client = stubClient();
    vi.spyOn(client, "info")
      .mockRejectedValueOnce(unauthorized())
      .mockRejectedValueOnce(
        new ClientError(
          403,
          "Your trusted sources OIDC token's environment is not permitted to access this deployment\n\n" +
            "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH\n\niad1::zgc5p-1781730251155-85842c28901b",
        ),
      );
    const commandInvocations: Array<{ text: string; status: "failed" | undefined }> = [];
    const commandResults: string[] = [];
    const flow = successfulAuth([
      { kind: "trusted-sources-updated", targetProjectName: "remote-agent" },
    ]);

    await runRemoteAuth({
      client,
      flow,
      renderer: {
        renderCommandInvocation: (text, status) => commandInvocations.push({ text, status }),
        renderCommandResult: (message) => commandResults.push(message),
      },
    });

    expect(commandInvocations).toEqual([{ text: "/vc:login", status: "failed" }]);
    expect(commandResults).toEqual([
      "Authentication was refreshed, but vpoke.playground-vercel.tools is unavailable: " +
        "Your trusted sources OIDC token's environment is not permitted to access this deployment.\n\n" +
        "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH Completed before the failure: updated Trusted Sources for remote-agent.",
    ]);
  });

  it("does not start authentication for an ordinary remote HTTP failure", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockRejectedValue(new ClientError(503, "Unavailable"));
    const flow = successfulAuth();

    await runRemoteAuth({ client, flow });

    expect(flow).not.toHaveBeenCalled();
  });

  it("demotes a ready remote after turn dispatch fails", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const session = client.session();
    vi.spyOn(session, "send").mockRejectedValue(new Error("socket down"));
    const statuses: string[] = [];
    const readPrompt = vi.fn().mockResolvedValueOnce("hello").mockResolvedValueOnce(undefined);

    await new EveTUIRunner({
      session,
      client,
      renderer: fakeRenderer({
        readPrompt,
        setRemoteConnectionStatus: (snapshot) => statuses.push(snapshot.connection.state),
      }),
      serverUrl: target.serverUrl,
      remote: remoteOptions(),
    }).run();

    expect(statuses.at(-1)).toBe("unavailable");
  });

  it("keeps a ready remote connected after an agent session failure", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const session = sessionYielding([
      {
        type: "session.failed",
        data: { code: "HookConflictError", message: "HookConflictError: token in use" },
      },
    ]);
    const statuses: string[] = [];
    const readPrompt = vi.fn().mockResolvedValueOnce("hello").mockResolvedValueOnce(undefined);

    await new EveTUIRunner({
      session,
      client,
      renderer: fakeRenderer({
        readPrompt,
        renderStream: vi.fn(async (result) => {
          for await (const event of result.events as AsyncIterable<unknown>) void event;
        }),
        setRemoteConnectionStatus: (snapshot) => statuses.push(snapshot.connection.state),
      }),
      serverUrl: target.serverUrl,
      remote: remoteOptions(),
    }).run();

    expect(statuses.at(-1)).toBe("ready");
    expect(statuses).not.toContain("unavailable");
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

  it("finishes the section on the child's own turn boundary, before subagent.completed", async () => {
    const client = stubClient();
    const childSession = client.session({ sessionId: "child-session", streamIndex: 0 });
    vi.spyOn(client, "session").mockReturnValue(childSession);
    vi.spyOn(childSession, "stream").mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "message.completed",
          data: {
            finishReason: "stop",
            message: "final answer",
            sequence: 0,
            stepIndex: 0,
            turnId: "turn-child",
          },
        } as HandleMessageStreamEvent;
        yield {
          type: "session.waiting",
          data: { wait: "next-user-message" },
        } as HandleMessageStreamEvent;
      },
    }));

    const completeSubagent = vi.fn();
    const completed = createDeferred<void>();
    const runner = new EveTUIRunner({
      client,
      name: "Weather Agent",
      renderer: fakeRenderer({
        // Hold the second prompt open until the child boundary finishes the
        // section — exiting the run loop aborts the child pump.
        readPrompt: vi
          .fn()
          .mockResolvedValueOnce("delegate")
          .mockImplementationOnce(async () => {
            await completed.promise;
            return undefined;
          }),
        renderStream: vi.fn(async (result) => {
          for await (const event of result.events as AsyncIterable<unknown>) void event;
        }),
        subagents: {
          begin: vi.fn(),
          upsertStep: vi.fn(),
          upsertTool: vi.fn(),
          removeTool: vi.fn(),
          markChildToolCallId: vi.fn(),
          complete: (update: { callId: string }) => {
            completeSubagent(update);
            completed.resolve();
          },
        },
      }),
      session: sessionYielding([
        {
          type: "subagent.called",
          data: {
            callId: "call-child",
            childSessionId: "child-session",
            name: "weather-child",
            sequence: 0,
            sessionId: "parent-session",
            toolName: "delegate_weather",
            turnId: "turn-parent",
            workflowId: "workflow-parent",
          },
        },
        // The parent stream never reports subagent.completed — the child's
        // own boundary must finish the section.
        { type: "turn.completed", data: { sequence: 0, turnId: "turn-parent" } },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]),
    });

    await runner.run();
    await completed.promise;

    expect(completeSubagent).toHaveBeenCalledWith({ callId: "call-child" });
  });

  it("aborts child-session streams when Ctrl-C exits the runner", async () => {
    const client = stubClient();
    const childSession = client.session({ sessionId: "child-session", streamIndex: 0 });
    let childSignal: AbortSignal | undefined;
    vi.spyOn(client, "session").mockReturnValue(childSession);
    vi.spyOn(childSession, "stream").mockImplementation((options) => {
      const signal = options?.signal;
      if (signal === undefined) {
        throw new Error("Expected the child stream to receive an abort signal.");
      }
      childSignal = signal;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield {
            type: "session.waiting",
            data: { wait: "next-user-message" },
          } as HandleMessageStreamEvent;
        },
      };
    });

    const runner = new EveTUIRunner({
      client,
      name: "Weather Agent",
      renderer: fakeRenderer({
        readPrompt: vi
          .fn()
          .mockResolvedValueOnce("delegate")
          .mockRejectedValueOnce(interruptedError()),
        renderStream: vi.fn(async (result) => {
          for await (const event of result.events as AsyncIterable<unknown>) void event;
        }),
      }),
      session: sessionYielding([
        {
          type: "subagent.called",
          data: {
            callId: "call-child",
            childSessionId: "child-session",
            name: "weather-child",
            sequence: 0,
            sessionId: "parent-session",
            toolName: "delegate_weather",
            turnId: "turn-parent",
            workflowId: "workflow-parent",
          },
        },
        { type: "turn.completed", data: { sequence: 0, turnId: "turn-parent" } },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]),
    });

    await runner.run();

    expect(childSignal?.aborted).toBe(true);
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
    expect(detectIdentity).toHaveBeenCalledWith("/tmp/weather-agent", {
      signal: expect.any(AbortSignal),
    });
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
        effect: { kind: "channels-added" },
      },
      deploy: { message: "Deployed.", effect: { kind: "deployed" } },
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

  it("refreshes agent info only after a model-access change", async () => {
    const client = stubClient();
    const info = vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const prompts: Array<string | undefined> = ["/channels", "/model", undefined];
    const infoCallsAtPrompt: number[] = [];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => {
        infoCallsAtPrompt.push(info.mock.calls.length);
        return prompts.shift();
      }),
    });
    const channelsOutcome: PromptCommandOutcome = {
      message: "Channels added.",
      effect: { kind: "channels-added" },
    };
    const modelOutcome: PromptCommandOutcome = {
      message: "Connected to AI Gateway.",
      effect: { kind: "model-access-changed" },
    };

    const runner = new EveTUIRunner({
      session: stubSession(),
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      bootDetections: [],
      detectProjectIdentity: vi.fn(async () => undefined),
      promptCommandHandler: {
        handle: async (command) => (command.name === "model" ? modelOutcome : channelsOutcome),
      },
    });

    await runner.run();

    expect(infoCallsAtPrompt).toEqual([1, 1, 2]);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("forces a runtime rebuild after /connect adds a connection", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        requests.push(url);
        return Response.json({ revision: url.searchParams.get("force") === "1" ? "next" : "base" });
      }),
    );
    const prompts: Array<string | undefined> = ["/connect", undefined];
    const renderer = fakeRenderer({ readPrompt: vi.fn(async () => prompts.shift()) });
    const connectOutcome = {
      message: "Connections added: linear.",
      effect: { kind: "connection-added" },
    } satisfies PromptCommandOutcome;

    const runner = new EveTUIRunner({
      session: stubSession(),
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
      promptCommandHandler: { handle: async () => connectOutcome },
    });
    await runner.run();

    expect(
      requests.some(
        (url) =>
          url.pathname === "/eve/v1/dev/runtime-artifacts/rebuild" &&
          url.searchParams.get("force") === "1",
      ),
    ).toBe(true);
  });

  it("forces a runtime rebuild through the /connect command path", async () => {
    const client = stubClient();
    vi.spyOn(client, "info").mockResolvedValue(AGENT_INFO);
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        requests.push(url);
        return Response.json({ revision: url.searchParams.get("force") === "1" ? "next" : "base" });
      }),
    );
    const runConnectionsFlow = vi.fn(async () => ({
      kind: "done" as const,
      addedConnections: ["linear"],
    }));
    const prompts: Array<string | undefined> = ["/connect", undefined];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => prompts.shift()),
      setupFlow: idleSetupFlow(),
    });

    const runner = new EveTUIRunner({
      session: stubSession(),
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      promptCommandHandler: createPromptCommandHandler({
        target: {
          kind: "local",
          serverUrl: "http://localhost:3000",
          workspaceRoot: "/tmp/weather-agent",
        },
        flows: { runConnectionsFlow },
      }),
    });
    await runner.run();

    expect(runConnectionsFlow).toHaveBeenCalledTimes(1);
    expect(
      requests.some(
        (url) =>
          url.pathname === "/eve/v1/dev/runtime-artifacts/rebuild" &&
          url.searchParams.get("force") === "1",
      ),
    ).toBe(true);
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
    message: "AI Gateway received no credentials.",
    details: {
      errorId: "err-1",
      name: "AI Gateway authentication failed",
      semanticErrorId: "gateway-auth-missing-credentials",
      hint: "Run `eve link` to populate `VERCEL_OIDC_TOKEN`, or set `AI_GATEWAY_API_KEY`…",
    },
  };

  async function errorEventsFor(
    appRoot?: string,
  ): Promise<Array<{ errorText: string; hint?: string }>> {
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
      .map((event) => event as { errorText: string; hint?: string });
  }

  it("swaps the hint for the local /model fix when setup commands are available", async () => {
    const errors = await errorEventsFor("/tmp/weather-agent");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errorText).toContain("MODEL_CALL_FAILED");
    expect(errors[0]!.hint).toBe(
      "Run /model to connect this to a project and refresh AI Gateway credentials, or set AI_GATEWAY_API_KEY manually in .env.local.",
    );
  });

  it("keeps the harness hint when the TUI has no local project to link", async () => {
    const errors = await errorEventsFor(undefined);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errorText).toContain("MODEL_CALL_FAILED");
    expect(errors[0]!.hint).toContain("eve link");
    expect(errors[0]!.hint).not.toContain("/model");
  });
});

describe("EveTUIRunner boot setup detection", () => {
  const disconnectedGatewayInfo: AgentInfoResult = {
    ...AGENT_INFO,
    agent: {
      ...AGENT_INFO.agent,
      model: {
        ...AGENT_INFO.agent.model,
        routing: { kind: "gateway", target: "openai" },
        endpoint: { kind: "gateway", connected: false },
      },
    },
  };

  function bootRunner(input: { appRoot?: string; issues: SetupIssue[] }) {
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

  function providerSetupRefreshRunner(input: {
    refreshInfo: () => Promise<AgentInfoResult>;
    renderer?: Partial<AgentTUIRenderer>;
    bootDetections?: BootDetection[];
  }) {
    const client = stubClient();
    vi.spyOn(client, "info")
      .mockResolvedValueOnce(disconnectedGatewayInfo)
      .mockImplementationOnce(input.refreshInfo);
    const renderer = fakeRenderer({
      renderSetupWarning: vi.fn(),
      setupFlow: createFakeSetupFlowRenderer(),
      ...input.renderer,
    });
    const runner = new EveTUIRunner({
      session: stubSession(),
      client,
      renderer,
      serverUrl: "http://localhost:3000",
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      initialInput: "/model",
      bootDetections: input.bootDetections ?? [
        {
          id: "test",
          detect: () => [
            {
              kind: "attention",
              label: "model provider not linked",
              command: "/model",
            },
          ],
        },
      ],
      detectProjectIdentity: vi.fn(async () => undefined),
      getVercelAuthStatus: vi.fn(async (): Promise<"authenticated"> => "authenticated"),
      promptCommandHandler: {
        handle: async () => ({
          message: "Connected to AI Gateway via AI_GATEWAY_API_KEY in .env.local.",
          effect: { kind: "model-access-changed" },
        }),
      },
    });

    return { client, runner };
  }

  it("surfaces detected issues as the attention line at boot", async () => {
    const { runner, warnings } = bootRunner({
      appRoot: "/tmp/weather-agent",
      issues: [{ kind: "attention", label: "AI Gateway credentials", command: "/model" }],
    });
    await runner.run();

    expect(warnings).toEqual(["1 setup issue: AI Gateway credentials · /model"]);
  });

  it("runs the initial model onboarding prerequisites before opening /model", async () => {
    const order: string[] = [];
    const authStatuses: Array<"cli-missing" | "logged-out" | "authenticated"> = [
      "cli-missing",
      "logged-out",
      "authenticated",
    ];
    const handle = vi.fn(async (command: { name: string }) => {
      order.push(command.name);
      return { message: "/model dismissed." };
    });
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async (options?: AgentTUISessionOptions) => {
        order.push("prompt");
        expect(options?.initialDraft).toBeUndefined();
        return undefined;
      }),
      setupFlow: createFakeSetupFlowRenderer(),
    });
    const runner = new EveTUIRunner({
      session: sessionYielding([]),
      renderer,
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      initialInput: "/model",
      bootDetections: [
        {
          id: "test",
          detect: () => [
            {
              kind: "attention",
              label: "model provider not linked",
              command: "/model",
            },
          ],
        },
      ],
      getVercelAuthStatus: vi.fn(async () => authStatuses.shift() ?? "authenticated"),
      promptCommandHandler: { handle },
    });

    await runner.run();

    expect(order).toEqual(["vc:install", "vc:login", "model", "prompt"]);
    expect(handle).toHaveBeenNthCalledWith(
      1,
      { type: "extension", name: "vc:install", argument: "" },
      expect.objectContaining({ keepSetupFlowOpen: true }),
    );
    expect(handle).toHaveBeenNthCalledWith(
      2,
      { type: "extension", name: "vc:login", argument: "" },
      expect.objectContaining({ keepSetupFlowOpen: true }),
    );
    expect(handle).toHaveBeenCalledWith(
      { type: "extension", name: "model", argument: "" },
      { renderer, title: "Weather Agent", initialModelStep: "provider" },
    );
  });

  it("stops onboarding when Vercel CLI installation leaves the CLI unavailable", async () => {
    const order: string[] = [];
    const authStatuses: Array<"cli-missing"> = ["cli-missing", "cli-missing"];
    const end = vi.fn();
    const setupFlow = createFakeSetupFlowRenderer({ end });
    const runner = new EveTUIRunner({
      session: sessionYielding([]),
      renderer: fakeRenderer({ setupFlow }),
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      initialInput: "/model",
      bootDetections: [
        {
          id: "test",
          detect: () => [
            {
              kind: "attention",
              label: "model provider not linked",
              command: "/model",
            },
          ],
        },
      ],
      getVercelAuthStatus: vi.fn(async () => authStatuses.shift() ?? "cli-missing"),
      promptCommandHandler: {
        handle: async (command) => {
          order.push(command.name);
          return { message: "/vc:install dismissed." };
        },
      },
    });

    await runner.run();

    expect(order).toEqual(["vc:install"]);
    expect(end).toHaveBeenCalledOnce();
  });

  it("does not auto-open /model outside the prefilled onboarding launch", async () => {
    const handle = vi.fn(async () => ({ message: "/model dismissed." }));
    const runner = new EveTUIRunner({
      session: sessionYielding([]),
      renderer: fakeRenderer({ setupFlow: createFakeSetupFlowRenderer() }),
      name: "Weather Agent",
      appRoot: "/tmp/weather-agent",
      bootDetections: [
        {
          id: "test",
          detect: () => [
            {
              kind: "attention",
              label: "model provider not linked",
              command: "/model",
            },
          ],
        },
      ],
      promptCommandHandler: { handle },
    });

    await runner.run();

    expect(handle).not.toHaveBeenCalled();
  });

  it("keeps a prefilled /model editable without a local app root", async () => {
    const handle = vi.fn(async () => ({ message: "/model dismissed." }));
    const readPrompt = vi.fn(async (options?: AgentTUISessionOptions) => {
      expect(options?.initialDraft).toBe("/model");
      return undefined;
    });
    const runner = new EveTUIRunner({
      session: sessionYielding([]),
      renderer: fakeRenderer({ readPrompt, setupFlow: createFakeSetupFlowRenderer() }),
      name: "Weather Agent",
      initialInput: "/model",
      promptCommandHandler: { handle },
    });

    await runner.run();

    expect(handle).not.toHaveBeenCalled();
  });

  it("normalizes a committed local key after automatic provider setup", async () => {
    const clearSetupWarning = vi.fn();
    const headers: AgentTUIAgentHeader[] = [];
    const detect = vi.fn(({ info }: { info?: AgentInfoResult }) =>
      info?.agent.model.endpoint?.kind === "gateway" && !info.agent.model.endpoint.connected
        ? [
            {
              kind: "attention" as const,
              label: "model provider not linked",
              command: "/model" as const,
            },
          ]
        : [],
    );
    const { client, runner } = providerSetupRefreshRunner({
      refreshInfo: async () => {
        vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
        return disconnectedGatewayInfo;
      },
      bootDetections: [{ id: "test", detect }],
      renderer: {
        clearSetupWarning,
        renderAgentHeader: (header) => headers.push(header),
      },
    });

    await runner.run();
    await vi.waitFor(() => expect(clearSetupWarning).toHaveBeenCalled());

    expect(client.info).toHaveBeenCalledTimes(2);
    expect(detect.mock.calls.at(-1)?.[0].info?.agent.model.endpoint).toEqual({
      kind: "gateway",
      connected: true,
      credential: "api-key",
    });
    expect(headers.map((header) => header.info?.agent.model.endpoint)).toEqual([
      { kind: "gateway", connected: false },
      { kind: "gateway", connected: true, credential: "api-key" },
    ]);
  });

  it("drops stale disconnected evidence when the post-setup info refresh fails", async () => {
    const clearSetupWarning = vi.fn();
    const headers: AgentTUIAgentHeader[] = [];
    const detect = vi.fn(({ info }: { info?: AgentInfoResult }) =>
      info?.agent.model.endpoint?.kind === "gateway" && !info.agent.model.endpoint.connected
        ? [
            {
              kind: "attention" as const,
              label: "model provider not linked",
              command: "/model" as const,
            },
          ]
        : [],
    );
    const { client, runner } = providerSetupRefreshRunner({
      refreshInfo: async () => {
        throw new Error("info unavailable");
      },
      bootDetections: [{ id: "test", detect }],
      renderer: {
        clearSetupWarning,
        renderAgentHeader: (header) => headers.push(header),
      },
    });

    await runner.run();
    await vi.waitFor(() => expect(clearSetupWarning).toHaveBeenCalled());

    expect(client.info).toHaveBeenCalledTimes(2);
    expect(detect.mock.calls.at(-1)?.[0].info).toBeUndefined();
    expect(headers.at(-1)?.info).toBeUndefined();
  });

  it("stays quiet without a local setup context, even with issues", async () => {
    const { runner, warnings } = bootRunner({
      issues: [{ kind: "attention", label: "AI Gateway credentials", command: "/model" }],
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
      promptCommandHandler: createPromptCommandHandler({
        target: {
          kind: "remote",
          workspaceRoot: "/tmp/weather-agent",
          serverUrl: "https://example.com/",
        },
      }),
    });
    await runner.run();

    expect(results).toHaveLength(1);
    expect(results[0]).toContain("--url");
    expect(notices).toEqual([]);
  });
});

describe("EveTUIRunner mid-turn message queue", () => {
  it("submits the queued prompt as the next turn without reading the prompt", async () => {
    const session = sessionYielding([{ type: "session.waiting" }]);
    const queued: Array<string | undefined> = ["queued follow-up", undefined];
    const prompts: Array<string | undefined> = ["hello", undefined];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
      takeQueuedPrompt: vi.fn(() => queued.shift()),
    });

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    expect(session.send).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: "hello" }));
    expect(session.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "queued follow-up" }),
    );
    // The drained prompt bypasses the interactive prompt read entirely.
    expect(renderer.readPrompt).toHaveBeenCalledTimes(2);
  });

  it("does not drain the queue when the stream ends without a turn boundary", async () => {
    const session = sessionYielding([]);
    const takeQueuedPrompt = vi.fn(() => "should stay queued");
    const prompts: Array<string | undefined> = ["hello", undefined];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
      takeQueuedPrompt,
    });

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    // The lost-stream turn keeps queued input for the prompt's draft restore.
    expect(takeQueuedPrompt).not.toHaveBeenCalled();
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it("retries a cancel that raced turn dispatch and scopes it once the turn id is known", async () => {
    const gate = createDeferred<void>();
    const session = stubSession();
    vi.spyOn(session, "send").mockImplementation(
      async () =>
        new MessageResponse({
          continuationToken: "eve:test",
          createStream: async function* () {
            yield { type: "turn.started", data: { turnId: "turn-1", sequence: 1 } } as never;
            // Hold the stream mid-turn until the retry loop has proven both
            // attempts, then settle the turn as cancelled.
            await gate.promise;
            yield { type: "turn.cancelled", data: { turnId: "turn-1", sequence: 2 } } as never;
            yield { type: "session.waiting" } as never;
          },
          sessionId: "session_test",
        }),
    );
    const cancelCalls: Array<{ turnId?: string } | undefined> = [];
    vi.spyOn(session, "cancel").mockImplementation(async (options?: { turnId?: string }) => {
      cancelCalls.push(options);
      if (cancelCalls.length >= 2) {
        gate.resolve();
        return { sessionId: "session_test", status: "accepted" as const };
      }
      // The first request raced the dispatch window: the turn workflow has
      // not claimed its cancel hook yet, so the server reports no turn.
      return { sessionId: "session_test", status: "no_active_turn" as const };
    });
    const prompts: Array<string | undefined> = ["hello", undefined];
    const seen: string[] = [];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        // Esc lands before the first stream event arrives.
        result.cancel?.();
        for await (const event of result.events as AsyncIterable<AgentTUIStreamEvent>) {
          seen.push(event.type);
        }
      }),
    });

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    // `turn.cancelled` reaches the renderer as its own stream event.
    expect(seen).toContain("turn-cancelled");
    expect(cancelCalls).toHaveLength(2);
    // First attempt fired before `turn.started` named the turn; the retry
    // carries the observed id so it can never cancel a later turn.
    expect(cancelCalls[0]).toBeUndefined();
    expect(cancelCalls[1]).toEqual({ turnId: "turn-1" });
  });

  it("drops a cancel request that arrives after the turn boundary", async () => {
    const session = sessionYielding([
      { type: "turn.started", data: { turnId: "turn-1", sequence: 1 } },
      { type: "session.waiting" },
    ]);
    const cancel = vi
      .spyOn(session, "cancel")
      .mockResolvedValue({ sessionId: "session_test", status: "accepted" });
    const prompts: Array<string | undefined> = ["hello", undefined];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
        // An Esc landing exactly as the boundary settles has nothing left
        // to cancel — and must not reach the next turn.
        result.cancel?.();
      }),
    });

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("EveTUIRunner session id reporting", () => {
  it("pushes the accepted session id and keeps it sticky across /new", async () => {
    const session = sessionYielding([{ type: "session.waiting" }]);
    vi.spyOn(session, "state", "get").mockReturnValue({
      sessionId: "session_test",
      streamIndex: 0,
    });
    const reported: string[] = [];
    const prompts: Array<string | undefined> = ["hello", "/new", undefined];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
      setSessionId: vi.fn((sessionId: string) => reported.push(sessionId)),
    });

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    // Named once the turn's send is accepted. `/new` (and interrupt
    // recovery, which shares #startNewSession) must NOT clear it: the
    // parting line names the last session this TUI talked to, and the
    // replacement session has no id until its first turn is accepted.
    expect(reported).toEqual(["session_test"]);
  });

  it("keeps the interrupted session's id for the parting line after Ctrl-C recovery", async () => {
    // A stream that never settles: the user interrupts it client-side.
    const gate = createDeferred<void>();
    const session = stubSession();
    vi.spyOn(session, "send").mockImplementation(
      async () =>
        new MessageResponse({
          continuationToken: "eve:test",
          createStream: async function* () {
            yield { type: "turn.started", data: { turnId: "turn-1", sequence: 1 } } as never;
            await gate.promise;
          },
          sessionId: "session_interrupted",
        }),
    );
    vi.spyOn(session, "state", "get").mockReturnValue({
      sessionId: "session_interrupted",
      streamIndex: 0,
    });
    const reported: string[] = [];
    const notices: string[] = [];
    const prompts: Array<string | undefined> = ["hello", undefined];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        // Ctrl-C: abort the turn without draining the stream.
        result.abort?.();
        gate.resolve();
      }),
      renderNotice: (text) => notices.push(text),
      setSessionId: vi.fn((sessionId: string) => reported.push(sessionId)),
    });

    const runner = new EveTUIRunner({ session, renderer, name: "Weather Agent" });
    await runner.run();

    // The abort recovery replaces the session but the reported id — what
    // the parting line prints — survives.
    expect(reported).toEqual(["session_interrupted"]);
    expect(notices.some((text) => text.includes("started a new session"))).toBe(true);
  });
});

describe("EveTUIRunner cancelled-turn subagent settling", () => {
  it("settles subagent sections when the turn is cancelled by a steer", async () => {
    // A child stream that never ends on its own — it only stops when the
    // pump aborts it (the settleAll path under test).
    const childStream = (options?: { signal?: AbortSignal }) => ({
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next: () =>
            new Promise((resolve) => {
              options?.signal?.addEventListener(
                "abort",
                () => resolve({ done: true, value: undefined }),
                { once: true },
              );
            }),
        };
      },
    });
    const client = stubClient();
    vi.spyOn(client, "session").mockReturnValue({
      stream: (options?: { signal?: AbortSignal }) => childStream(options),
    } as never);

    const session = sessionYielding([
      {
        type: "subagent.called",
        data: {
          callId: "call-1",
          childSessionId: "child-1",
          name: "researcher",
          sequence: 1,
          turnId: "turn-1",
        },
      },
      { type: "turn.cancelled", data: { turnId: "turn-1", sequence: 2 } },
      { type: "session.waiting" },
    ]);
    const view = {
      begin: vi.fn(),
      upsertStep: vi.fn(),
      upsertTool: vi.fn(),
      removeTool: vi.fn(),
      complete: vi.fn(),
      markChildToolCallId: vi.fn(),
    };
    const prompts: Array<string | undefined> = ["hello", undefined];
    const renderer = fakeRenderer({
      readPrompt: vi.fn(async () => prompts.shift()),
      renderStream: vi.fn(async (result) => {
        for await (const event of result.events as AsyncIterable<unknown>) {
          void event;
        }
      }),
      subagents: view,
    });

    const runner = new EveTUIRunner({ session, client, renderer, name: "Weather Agent" });
    await runner.run();

    expect(view.begin).toHaveBeenCalledWith({ callId: "call-1", name: "researcher" });
    // `subagent.completed` never arrives for a cancelled delegation — the
    // cancellation itself must close the section.
    expect(view.complete).toHaveBeenCalledWith({ callId: "call-1" });
  });
});

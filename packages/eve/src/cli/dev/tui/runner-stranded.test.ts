import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/index.js";

import { EveTUIRunner, type AgentTUIRenderer, type AgentTUISessionOptions } from "./runner.js";
import type { AgentTUIConversationView } from "./conversation-view.js";
import type { DevDiagnostics } from "../diagnostics.js";
import { FakeEveServer, reply } from "./test/fake-eve-server.js";

beforeEach(() => {
  // A developer shell exporting gateway credentials must not leak into boot state.
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * A composer that submits each text once the previous turn settles, then
 * leaves. It closes when the runner needs the keyboard for something else.
 */
function turnTaking(texts: Array<string | undefined>, overrides: Partial<AgentTUIRenderer> = {}) {
  const views: AgentTUIConversationView[] = [];
  const renderer: AgentTUIRenderer = {
    renderConversation: (view) => views.push(view),
    readInput: vi.fn(async (options?: AgentTUISessionOptions) => {
      const closed = new Promise<"closed">((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve("closed"), { once: true }),
      );
      const idle = vi
        .waitFor(() => {
          if (views.at(-1)?.working === true) throw new Error("A turn is still running.");
        })
        .then(() => "idle" as const);
      if ((await Promise.race([closed, idle])) === "closed") return undefined;
      const text = texts.shift();
      return text === undefined ? undefined : ({ type: "submit", text } as const);
    }),
    ...overrides,
  };
  return { renderer, views };
}

describe("EveTUIRunner with a stranded session", () => {
  it("names a stranded session, refuses to clear it, and starts fresh after /new", async () => {
    const server = new FakeEveServer();
    const stranded = {
      code: "session_stranded",
      error: "This session is stranded.",
      eveVersion: "0.0.1",
      ok: false,
    };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (
        init?.method === "POST" &&
        (path === "/eve/v1/session/session_1" || path === "/eve/v1/session/session_1/clear")
      ) {
        await server.fetch(input, init);
        return Response.json(stranded, { status: 409 });
      }
      return await server.fetch(input, init);
    });
    const outcomes: unknown[] = [];
    const renderError = vi.fn();
    await new EveTUIRunner({
      client: new Client({ baseUrl: "http://localhost:3000" }),
      renderer: turnTaking(
        ["Hello.", "Still there?", "/clear", "/new", "Fresh start.", undefined],
        { finishCommand: (outcome) => outcomes.push(outcome), renderError },
      ).renderer,
    }).run();

    const notice =
      "Session session_1 is stranded (built by eve 0.0.1): the deployment that ran it is no longer available. The session cannot continue. Run /new to end it and start a fresh session.";
    expect(renderError).toHaveBeenCalledWith("Session stranded", notice);
    expect(outcomes).toEqual([
      { kind: "result", message: notice, summary: "Couldn't clear the session" },
      { kind: "dismiss" },
    ]);
    expect(server.requestsTo("POST", "/session_1/clear")).toHaveLength(1);
    expect(server.requestsTo("POST", "/session_1/reset")).toHaveLength(1);
    expect(server.sessionId).toBe("session_2");
  });
});

describe("EveTUIRunner diagnostics", () => {
  it("names a tool that fails in the commit that requested it", async () => {
    const replied = reply("The lookup failed.");
    const server = new FakeEveServer((request) => {
      const events = replied(request);
      const runId = `${request.turnId}.run`;
      const at = events.findIndex((event) => event.type === "model.started") + 1;
      return [
        ...events.slice(0, at),
        {
          data: {
            callId: "call_1",
            capability: { kind: "tool", name: "lookup" },
            owner: { runId },
          },
          scope: { runId, turnId: request.turnId },
          type: "call.requested",
        },
        {
          data: {
            callId: "call_1",
            error: { code: "TOOL_FAILED", message: "The ledger is offline." },
            outcome: "failed",
          },
          scope: { turnId: request.turnId },
          type: "call.settled",
        },
        ...events.slice(at),
      ];
    });
    vi.stubGlobal("fetch", server.fetch);
    const append = vi.fn<DevDiagnostics["append"]>();
    const diagnostics: DevDiagnostics = {
      displayPath: "diagnostics.jsonl",
      append,
      recordPrompt: () => {},
      recordStepUsage: () => {},
      recordSubagentDispatch: () => {},
      recordToolCall: () => {},
      reportStats: () => {},
      subscribeLogRecords: () => {},
      unsubscribeLogRecords: () => {},
      close: async () => {},
    };

    await new EveTUIRunner({
      client: new Client({ baseUrl: "http://localhost:3000" }),
      diagnostics,
      renderer: turnTaking(["Look up the ledger.", undefined]).renderer,
    }).run();

    expect(append).toHaveBeenCalledWith({
      detail: "The ledger is offline.",
      source: "tool",
      summary: "lookup failed",
    });
  });
});

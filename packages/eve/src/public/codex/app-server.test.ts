import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createCodexAppServerSessionWithSpawn } from "#public/codex/app-server.js";

describe("Codex app-server session", () => {
  it("enables dynamic tools and translates the v2 event stream", async () => {
    const child = new FakeChildProcess();
    const requests: Array<Record<string, unknown>> = [];
    child.stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
      requests.push(request);
      switch (request.method) {
        case "initialize":
          child.respond(request.id, {});
          return;
        case "initialized":
          return;
        case "thread/start":
          child.respond(request.id, { thread: { id: "thread-1" } });
          return;
        case "turn/start":
          child.respond(request.id, { turn: { id: "turn-1" } });
          return;
        default:
          throw new Error(`Unexpected request ${String(request.method)}.`);
      }
    });
    const spawnProcess = vi.fn(() => child);
    const session = createCodexAppServerSessionWithSpawn(spawnProcess);
    const listener = {
      onCompleted: vi.fn(),
      onError: vi.fn(),
      onTextDelta: vi.fn(),
      onToolCall: vi.fn(),
      onUsage: vi.fn(),
    };

    await session.start({
      input: [{ text: "Hello", type: "text" }],
      listener,
      model: "gpt-5.2-codex",
      outputSchema: { type: "object" },
      tools: [
        {
          description: "Get weather.",
          inputSchema: { type: "object" },
          name: "weather",
        },
      ],
    });

    expect(spawnProcess).toHaveBeenCalledWith("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(requests).toEqual([
      expect.objectContaining({
        id: 1,
        method: "initialize",
        params: expect.objectContaining({
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
      }),
      { method: "initialized" },
      expect.objectContaining({
        id: 2,
        method: "thread/start",
        params: expect.objectContaining({
          config: { web_search: "disabled" },
          dynamicTools: [
            {
              description: "Get weather.",
              inputSchema: { type: "object" },
              name: "weather",
              type: "function",
            },
          ],
          environments: [],
          ephemeral: true,
          model: "gpt-5.2-codex",
        }),
      }),
      expect.objectContaining({
        id: 3,
        method: "turn/start",
        params: {
          input: [{ text: "Hello", text_elements: [], type: "text" }],
          outputSchema: { type: "object" },
          threadId: "thread-1",
        },
      }),
    ]);

    child.notify("item/agentMessage/delta", {
      delta: "Hi",
      itemId: "message-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    child.notify(
      "item/tool/call",
      {
        arguments: { city: "Boston" },
        callId: "call-1",
        namespace: null,
        threadId: "thread-1",
        tool: "weather",
        turnId: "turn-1",
      },
      4,
    );
    child.notify("thread/tokenUsage/updated", {
      threadId: "thread-1",
      tokenUsage: {
        last: {
          cachedInputTokens: 4,
          inputTokens: 12,
          outputTokens: 8,
          reasoningOutputTokens: 3,
        },
      },
      turnId: "turn-1",
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { error: null, status: "completed" },
    });

    expect(listener.onTextDelta).toHaveBeenCalledWith({ delta: "Hi", id: "message-1" });
    expect(listener.onToolCall).toHaveBeenCalledWith({
      arguments: { city: "Boston" },
      callId: "call-1",
      namespace: null,
      requestId: 4,
      tool: "weather",
    });
    expect(listener.onUsage).toHaveBeenCalledWith({
      cachedInputTokens: 4,
      inputTokens: 12,
      outputTokens: 8,
      reasoningOutputTokens: 3,
    });
    expect(listener.onCompleted).toHaveBeenCalledWith({ status: "completed" });
    expect(listener.onError).not.toHaveBeenCalled();

    session.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

class FakeChildProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();

  notify(method: string, params: unknown, id?: number): void {
    this.stdout.write(
      `${JSON.stringify(id === undefined ? { method, params } : { id, method, params })}\n`,
    );
  }

  respond(id: unknown, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }
}

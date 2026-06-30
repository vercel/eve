import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type {
  CodexAppServerListener,
  CodexAppServerSession,
  CodexAppServerToolCall,
  CodexAppServerUsage,
} from "#internal/model-auth/codex/types.js";
import {
  assertCodexAuthStateAuthenticated,
  readCodexAuthState,
  type CodexAuthState,
} from "#internal/model-auth/codex/auth.js";

type JsonRpcId = number | string;

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: unknown): void;
}

export interface CodexAppServerProcess {
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  kill(): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"] },
) => CodexAppServerProcess;

export interface CodexAppServerSessionOptions {
  readonly readAuthState?: () => Promise<CodexAuthState>;
}

// The Codex auth boundary is local login state. eve checks ~/.codex/auth.json
// before starting the transport, but never accepts or forwards token values.
export function createCodexAppServerSession(): CodexAppServerSession {
  return createCodexAppServerSessionWithSpawn((command, args, options) =>
    spawn(command, args, options),
  );
}

// Test seam for the local process boundary.
export function createCodexAppServerSessionWithSpawn(
  spawnProcess: CodexAppServerSpawn,
  options: CodexAppServerSessionOptions = {},
): CodexAppServerSession {
  return new LocalCodexAppServerSession(spawnProcess, options.readAuthState ?? readCodexAuthState);
}

class LocalCodexAppServerSession implements CodexAppServerSession {
  #child: CodexAppServerProcess | undefined;
  #disposed = false;
  #listener: CodexAppServerListener | undefined;
  #nextRequestId = 1;
  #pendingRequests = new Map<JsonRpcId, PendingRequest>();
  #stderr = "";
  #stdout: Interface | undefined;

  readonly #spawnProcess: CodexAppServerSpawn;
  readonly #readAuthState: () => Promise<CodexAuthState>;

  constructor(spawnProcess: CodexAppServerSpawn, readAuthState: () => Promise<CodexAuthState>) {
    this.#spawnProcess = spawnProcess;
    this.#readAuthState = readAuthState;
  }

  async start(input: Parameters<CodexAppServerSession["start"]>[0]): Promise<void> {
    if (this.#child !== undefined) {
      throw new Error("Expected one Codex app-server session to start only once.");
    }

    assertCodexAuthStateAuthenticated(await this.#readAuthState());

    this.#listener = input.listener;
    const child = this.#spawnProcess("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      this.dispose();
      throw new Error("Codex app-server did not expose its standard I/O streams.");
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", (error) => {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", (code, signal) => {
      if (this.#disposed) return;
      const detail =
        this.#stderr.trim() === ""
          ? ""
          : ` Codex stderr: ${this.#stderr.trim().replaceAll(/\s+/g, " ")}`;
      this.#fail(
        new Error(
          `Codex app-server exited before completing the model call (code ${String(code)}, signal ${signal ?? "none"}).${detail}`,
        ),
      );
    });

    const lines = createInterface({ input: child.stdout });
    this.#stdout = lines;
    lines.on("line", (line) => {
      this.#handleLine(line);
    });

    await this.#request("initialize", {
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
      clientInfo: {
        name: "eve",
        title: "eve",
        version: "0",
      },
    });
    this.#write({ method: "initialized" });
    const threadStart = await this.#request("thread/start", {
      config: { web_search: "disabled" },
      dynamicTools: input.tools.map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name,
        type: "function",
      })),
      environments: [],
      ephemeral: true,
      model: input.model,
      serviceName: "eve",
    });
    const threadId = readThreadId(threadStart);
    const turnInput = input.input.map((entry) =>
      entry.type === "text"
        ? { text: entry.text, text_elements: [], type: "text" }
        : { type: "image", url: entry.url },
    );
    const turnStart: {
      input: typeof turnInput;
      outputSchema?: typeof input.outputSchema;
      threadId: string;
    } = { input: turnInput, threadId };
    if (input.outputSchema !== undefined) {
      turnStart.outputSchema = input.outputSchema;
    }
    await this.#request("turn/start", turnStart);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stdout?.close();
    this.#stdout = undefined;
    this.#rejectPendingRequests(new Error("Codex app-server session closed."));
    this.#child?.kill();
    this.#child = undefined;
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new Error("expected a JSON object");
      }
      message = parsed;
    } catch (error) {
      this.#fail(
        new Error(
          `Codex app-server emitted invalid JSON-RPC: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    const id = readJsonRpcId(message.id);
    const method = message.method;
    if (id !== undefined && typeof method === "string") {
      this.#handleServerRequest(id, method, message.params);
      return;
    }
    if (id !== undefined) {
      const request = this.#pendingRequests.get(id);
      if (request === undefined) return;
      this.#pendingRequests.delete(id);
      if ("error" in message) {
        request.reject(new Error(readJsonRpcError(message.error)));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (typeof method === "string") {
      this.#handleNotification(method, message.params);
    }
  }

  #handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method !== "item/tool/call") {
      this.#write({
        error: {
          code: -32601,
          message: `eve only accepts dynamic tool calls from Codex app-server, not "${method}".`,
        },
        id,
      });
      return;
    }

    const toolCall = parseToolCall(id, params);
    if (toolCall === null) {
      this.#write({
        error: {
          code: -32602,
          message: "Codex sent an invalid dynamic tool call.",
        },
        id,
      });
      return;
    }
    this.#listener?.onToolCall(toolCall);
  }

  #handleNotification(method: string, params: unknown): void {
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = parseTextDelta(params);
        if (delta !== null) {
          this.#listener?.onTextDelta(delta);
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = parseUsage(params);
        if (usage !== null) {
          this.#listener?.onUsage(usage);
        }
        return;
      }
      case "turn/completed": {
        const completed = parseTurnCompleted(params);
        if (completed !== null) {
          this.#listener?.onCompleted(completed);
        }
        return;
      }
      case "error":
        this.#listener?.onError(new Error(readJsonRpcError(params)));
        return;
      default:
        return;
    }
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(id, { reject, resolve });
      this.#write({ id, method, params });
    });
  }

  #write(message: Record<string, unknown>): void {
    if (this.#disposed || this.#child?.stdin === null || this.#child?.stdin === undefined) {
      return;
    }
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error: Error): void {
    if (this.#disposed) return;
    this.#rejectPendingRequests(error);
    this.#listener?.onError(error);
  }

  #rejectPendingRequests(error: Error): void {
    for (const request of this.#pendingRequests.values()) {
      request.reject(error);
    }
    this.#pendingRequests.clear();
  }
}

function readThreadId(value: unknown): string {
  const result = isRecord(value) ? value : undefined;
  const thread = result !== undefined && isRecord(result.thread) ? result.thread : undefined;
  if (typeof thread?.id !== "string" || thread.id.length === 0) {
    throw new Error("Codex app-server returned an invalid thread/start response.");
  }
  return thread.id;
}

function parseToolCall(id: JsonRpcId, value: unknown): CodexAppServerToolCall | null {
  if (!isRecord(value)) return null;
  const callId = value.callId;
  const namespace = value.namespace;
  const tool = value.tool;
  if (
    typeof callId !== "string" ||
    (typeof namespace !== "string" && namespace !== null) ||
    typeof tool !== "string"
  ) {
    return null;
  }
  return {
    arguments: value.arguments,
    callId,
    namespace,
    requestId: id,
    tool,
  };
}

function parseTextDelta(value: unknown): { readonly delta: string; readonly id: string } | null {
  if (!isRecord(value) || typeof value.delta !== "string" || typeof value.itemId !== "string") {
    return null;
  }
  return { delta: value.delta, id: value.itemId };
}

function parseUsage(value: unknown): CodexAppServerUsage | null {
  if (!isRecord(value) || !isRecord(value.tokenUsage) || !isRecord(value.tokenUsage.last)) {
    return null;
  }
  const last = value.tokenUsage.last;
  if (
    typeof last.cachedInputTokens !== "number" ||
    typeof last.inputTokens !== "number" ||
    typeof last.outputTokens !== "number" ||
    typeof last.reasoningOutputTokens !== "number"
  ) {
    return null;
  }
  return {
    cachedInputTokens: last.cachedInputTokens,
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    reasoningOutputTokens: last.reasoningOutputTokens,
  };
}

function parseTurnCompleted(
  value: unknown,
): { readonly error?: string; readonly status: "completed" | "failed" | "interrupted" } | null {
  if (!isRecord(value) || !isRecord(value.turn)) return null;
  const status = value.turn.status;
  if (status !== "completed" && status !== "failed" && status !== "interrupted") {
    return null;
  }
  const error =
    isRecord(value.turn.error) && typeof value.turn.error.message === "string"
      ? value.turn.error.message
      : undefined;
  return error === undefined ? { status } : { error, status };
}

function readJsonRpcError(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return "Codex app-server returned an unknown JSON-RPC error.";
}

function readJsonRpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

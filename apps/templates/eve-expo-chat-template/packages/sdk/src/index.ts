import { createHash, randomUUID } from "node:crypto";
import { relayUrl } from "@eve-start/protocol";
import type {
  AgentEvent,
  BrowserBackend,
  BrowserCommand,
  Message,
  ToolCall,
  ReplyDelta,
} from "@eve-start/protocol";
export class EveClient implements BrowserBackend {
  readonly url: string;
  readonly token: string;
  readonly bypassToken?: string;
  constructor(url: string, token: string, options: { bypassToken?: string } = {}) {
    this.url = relayUrl(url);
    this.token = token;
    this.bypassToken = options.bypassToken ?? process.env.EVE_RELAY_BYPASS_TOKEN;
  }
  async request<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    timeoutMs = 20_000,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    if (this.bypassToken) headers["x-vercel-protection-bypass"] = this.bypassToken;
    const response = await fetch(`${this.url}/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw Error(
        response.status === 401 || response.status === 403
          ? "Deployment protection blocked access. Run ./scripts/setup.sh to provision the required bypass tokens."
          : "The app returned an unexpected response. Check its URL and run ./scripts/setup.sh.",
      );
    }
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(`${response.status}: ${data.error || response.statusText}`);
    return data;
  }
  async execute(command: BrowserCommand): Promise<unknown> {
    const response = await this.request<{ result?: unknown }>(
      "agent/browser/execute",
      command,
      "POST",
      95_000,
    );
    return response.result;
  }
  async getState<T>(key: string): Promise<T | null> {
    return (await this.request<{ value: T | null }>(`agent/state/${encodeURIComponent(key)}`))
      .value;
  }
  async setState(key: string, value: unknown): Promise<void> {
    await this.request(`agent/state/${encodeURIComponent(key)}`, { value }, "PUT");
  }
  async history(): Promise<Message[]> {
    return (await this.request<{ messages: Message[] }>("agent/history")).messages;
  }
  async reply(text: string, id: string = randomUUID(), tools: ToolCall[] = []): Promise<void> {
    await this.request("agent/messages", { text, id, tools });
  }
  async notify(text: string, dedupeKey: string): Promise<boolean> {
    return (await this.request<{ queued: boolean }>("agent/notify", { text, dedupeKey })).queued;
  }
  async flushNotifications(): Promise<void> {
    await this.request("agent/notifications/flush", {});
  }
}
// Stable response IDs prevent duplicate chat replies when an event is redelivered.
export function responseId(eventId: string): string {
  const hex = createHash("sha256").update(`eve:response:${eventId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Projects a native eve turn into app-owned chat history. This never runs the agent. */
export async function projectReply(
  eve: EveClient,
  event: AgentEvent,
  receive: () => Promise<string | AsyncIterable<ReplyDelta>>,
): Promise<void> {
  const id = responseId(event.id);
  const tools: ToolCall[] = [];
  let text = "",
    lastSnapshot = "",
    truncated = false,
    writeError: unknown,
    writing: Promise<void> | undefined;
  const progress = (status: "streaming" | "error" = "streaming") =>
    eve.request(
      `agent/streams/${id}`,
      { eventId: event.id, text: text.slice(0, 20000), tools, status },
      "PUT",
    );
  const flush = () => {
    const snapshot = JSON.stringify([text, tools]);
    if (writing || writeError || snapshot === lastSnapshot) return;
    writing = progress()
      .then(() => {
        lastSnapshot = snapshot;
      })
      .catch((error) => {
        writeError = error;
      })
      .finally(() => {
        writing = undefined;
      });
  };
  const timer = setInterval(flush, 50);
  try {
    await progress();
    const reply = await receive();
    if (typeof reply === "string") text = reply;
    else
      for await (const delta of reply) {
        if (typeof delta !== "string") {
          const existing = tools.find((call) => call.id === delta.id);
          if (existing) existing.status = delta.status;
          else if (tools.length < 100)
            tools.push({
              id: delta.id,
              name: delta.name,
              status: delta.status,
              offset: Math.min(text.length, 20000),
            });
        } else if (!truncated) {
          text += delta;
          if (text.length > 20000) {
            text = text.slice(0, 19950) + "\n\n[Response truncated.]";
            truncated = true;
          }
        }
        if (writeError) throw writeError;
        flush();
      }
    for (const call of tools)
      if (call.status === "running" || call.status === "preparing") call.status = "interrupted";
    text = text.length > 20000 ? text.slice(0, 19950) + "\n\n[Response truncated.]" : text;
    clearInterval(timer);
    await writing;
    if (writeError) throw writeError;
    if (JSON.stringify([text, tools]) !== lastSnapshot) await progress();
    await eve.reply(
      text.trim() || "I could not finish that response. Please try again.",
      id,
      tools,
    );
  } catch (error) {
    clearInterval(timer);
    await writing;
    for (const call of tools)
      if (call.status === "running" || call.status === "preparing") call.status = "interrupted";
    await progress("error").catch(() => {});
    throw error;
  } finally {
    clearInterval(timer);
  }
}
/** A production connector can implement this contract without changing agent logic. */
export interface ChatConnector {
  reply(text: string, id?: string): Promise<void>;
  notify(text: string, dedupeKey: string): Promise<boolean>;
}

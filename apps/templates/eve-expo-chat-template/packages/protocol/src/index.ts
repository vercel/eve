import { z } from "zod";
export const browserCommand = z.object({
  type: z.literal("agent-browser"),
  args: z.array(z.string().max(100000)).min(1).max(100),
  backend: z.enum(["local", "sandbox"]).optional(),
});
export type BrowserCommand = z.infer<typeof browserCommand>;
export const toolCall = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  status: z.enum(["preparing", "running", "completed", "failed", "interrupted"]),
  offset: z.number().int().min(0).max(20000),
});
export type ToolCall = z.infer<typeof toolCall>;
export type ReplyDelta =
  | string
  | { type: "tool"; id: string; name: string; status: ToolCall["status"] };
export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  tools?: ToolCall[];
};
export type AgentEvent = { id: string; text: string; createdAt: number };
export type Job = { id: string; command: BrowserCommand; lease: string };
export interface BrowserBackend {
  execute(command: BrowserCommand): Promise<unknown>;
}
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function relayUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Relay URL must be an origin");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        url.hostname,
      )
    )
  )
    throw new Error("Use HTTPS, or a local development address");
  return url.origin;
}

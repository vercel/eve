import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const path = (sessionId: string) =>
  join(tmpdir(), `eve-code-mode-${encodeURIComponent(sessionId)}.calls`);
export function counters(sessionId: string): Record<string, number> {
  let content: string;
  try {
    content = readFileSync(path(sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const counts: Record<string, number> = {};
  for (const tool of content.trim().split("\n")) if (tool) counts[tool] = (counts[tool] ?? 0) + 1;
  return counts;
}
export function increment(sessionId: string, tool: string): number {
  appendFileSync(path(sessionId), `${tool}\n`);
  return counters(sessionId)[tool]!;
}

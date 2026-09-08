import { join } from "node:path";
import { z } from "zod";

export const promptRecordSchema = z.object({
  turnId: z.string(),
  stepIndex: z.number(),
  instructions: z.string(),
  messages: z.array(z.string()),
});

export function promptRecordsPath(sessionId: string): string {
  return join(process.cwd(), ".eve", "prompt-cache", `${sessionId}.jsonl`);
}

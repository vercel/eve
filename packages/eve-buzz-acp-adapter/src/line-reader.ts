import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { JsonRpcMessage } from "./types.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;

export async function* readJsonLines(input: Readable): AsyncGenerator<JsonRpcMessage> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("ACP message exceeds 16 MiB");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("ACP transport received invalid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("ACP transport received a non-object JSON message");
    }
    yield value as JsonRpcMessage;
  }
}

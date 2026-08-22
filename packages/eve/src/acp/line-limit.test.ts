import { describe, expect, it } from "vitest";

import { limitAcpLineBytes } from "#acp/line-limit.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe("limitAcpLineBytes", () => {
  it("counts a line across chunks and resets at each newline", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"));
        controller.enqueue(new TextEncoder().encode("45\n12345\n"));
        controller.close();
      },
    });

    await expect(readAll(input.pipeThrough(limitAcpLineBytes(5)))).resolves.toBe("12345\n12345\n");
  });

  it("rejects an oversized unterminated line", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
        controller.close();
      },
    });

    await expect(readAll(input.pipeThrough(limitAcpLineBytes(5)))).rejects.toThrow(
      "5-byte line limit",
    );
  });
});

import { describe, expect, it } from "vitest";

import { EveAttachmentError } from "#internal/attachments/errors.js";
import { assertWithinLimit, readLimitedBytes } from "#internal/attachments/limited-read.js";

const MB = 1024 * 1024;

/** A body that streams `total` bytes in `chunk`-sized pieces and declares no length. */
function streamed(total: number, chunk: number): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const size = Math.min(chunk, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return new Response(body);
}

describe("readLimitedBytes", () => {
  it("reads a body within the limit", async () => {
    const bytes = await readLimitedBytes(new Response("hello"), 5, "test");
    expect(bytes.toString()).toBe("hello");
  });

  it("refuses a body whose declared length is over the limit before reading it", async () => {
    const response = new Response(new Uint8Array(10), {
      headers: { "content-length": "26214401" },
    });
    await expect(readLimitedBytes(response, 25 * MB, "test")).rejects.toThrow(
      new EveAttachmentError({
        adapterKind: "test",
        kind: "resolver-threw",
        message: "it is over the 25 MB upload limit.",
      }),
    );
  });

  it("stops a large body without a declared length once it passes the limit", async () => {
    let pulled = 0;
    const response = streamed(30 * MB, MB);
    const counting = new Response(
      response.body!.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      ),
    );

    await expect(readLimitedBytes(counting, 25 * MB, "test")).rejects.toThrow(
      "it is over the 25 MB upload limit.",
    );
    expect(pulled).toBeLessThanOrEqual(27 * MB);
  });
});

describe("assertWithinLimit", () => {
  it("fails bytes over the limit", () => {
    expect(() => assertWithinLimit(new Uint8Array(6), 5, "test")).toThrow(EveAttachmentError);
    expect(() => assertWithinLimit(new Uint8Array(5), 5, "test")).not.toThrow();
  });
});

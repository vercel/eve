import { join } from "node:path";

import { defineEval } from "eve/evals";

/**
 * Core session-route runtime behavior: multimodal attachments.
 *
 * Multimodal turn: a local PNG inlined as a data: URL FilePart must reach
 * the runtime. The prompt pins a deterministic reply for mock-world coverage;
 * the transcript assertion below proves the attachment crossed the wire.
 *
 * Also asserts the transcript projection: `message.received` must carry a
 * structured image/png file part so clients can render the attachment instead
 * of parsing the flattened placeholder summary.
 */
export default defineEval({
  description: "Session runtime smoke: attachments.",

  async test(t) {
    // Eval modules execute from a build cache, so assets resolve against
    // the app root (`eve eval` runs with the app as cwd), not import.meta.
    const filePath = join(process.cwd(), "evals/assets/cat-image.png");
    const turn = await t.sendFile(
      "The attached fixture image depicts a cat. Reply with exactly: cat",
      filePath,
      "image/png",
    );
    turn.expectOk();

    const received = turn.events.find(
      (event): event is Extract<typeof event, { type: "message.received" }> =>
        event.type === "message.received",
    );
    const fileParts = received?.data.parts?.filter((part) => part.type === "file") ?? [];
    if (fileParts.length === 0 || fileParts[0]?.mediaType !== "image/png") {
      throw new Error(
        "message.received did not project a structured image/png file part. " +
          `Saw parts: ${JSON.stringify(received?.data.parts)}`,
      );
    }

    t.succeeded();
    t.messageIncludes(/cat/i);
  },
});

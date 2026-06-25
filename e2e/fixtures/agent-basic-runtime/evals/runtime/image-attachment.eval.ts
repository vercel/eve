import { join } from "node:path";

import { defineEval } from "eve/evals";

/**
 * Core session-route runtime behavior: multimodal attachments.
 *
 * Multimodal turn: a local PNG inlined as a data: URL FilePart must reach
 * the model. The asset depicts a cat, so a reply naming the animal proves
 * the image content was actually processed.
 */
export default defineEval({
  description: "Session runtime smoke: attachments.",

  async test(t) {
    // Eval modules execute from a build cache, so assets resolve against
    // the app root (`eve eval` runs with the app as cwd), not import.meta.
    const filePath = join(process.cwd(), "evals/assets/cat-image.png");
    await t.sendFile(
      "What animal is in this image? Answer in one short sentence.",
      filePath,
      "image/png",
    );

    t.succeeded();
    t.messageIncludes(/cat/i);
  },
});

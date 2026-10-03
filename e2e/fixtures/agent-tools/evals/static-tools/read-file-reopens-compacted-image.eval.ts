import { createHash } from "node:crypto";
import { defineEval } from "eve/evals";

import {
  assistantAnswers,
  isRenderStripesOutput,
  namesColorsInOrder,
  TOOL_NAME,
} from "./render-stripes-shared";

// Compaction summarizes the tool result away, but the image stays staged in
// the sandbox under a content-addressed path. `read_file` must show it to the
// model again. The eval derives the staged path from the tool's answer key, so
// the follow-up does not depend on the summary keeping the path. The
// fixture's mock model decodes the pixels and fails the turn when the
// reopened image is missing; live color recognition is tracked, not gated.
export default defineEval({
  description: "read_file reopens a tool image after compaction removes it from the prompt.",
  async test(t) {
    const shown = await t.send(
      `Call \`${TOOL_NAME}\` exactly once, look at the rendered image, and reply with only ` +
        "the stripe colors left to right, comma-separated.",
    );
    shown.expectOk();
    shown.calledTool(TOOL_NAME, { count: 1, output: isRenderStripesOutput });
    const output = shown.requireToolCall(TOOL_NAME).output as { readonly imageBase64: string };
    const session = shown.session;

    const liveCompaction = t.target.watchTurn(session.sessionId, {
      startIndex: session.events.length,
    });
    const response = await t.target.fetch(
      `/eve/v1/session/${encodeURIComponent(session.sessionId)}/compact`,
      { body: "{}", headers: { "content-type": "application/json" }, method: "POST" },
    );
    if (!response.ok) {
      throw new Error(
        `Compacting the session failed (${response.status}): ${await response.text()}`,
      );
    }
    const compacted = await liveCompaction.result();
    compacted.event("compaction.completed", { count: 1 });
    compacted.notEvent("session.failed");

    const reopened = await session.send(
      `Earlier context was compacted. The \`${TOOL_NAME}\` image is saved at ` +
        `${stagedImagePath(output.imageBase64)}. Open that file with \`read_file\` before ` +
        "answering, even if you remember the colors, then reply with only the stripe colors " +
        "left to right, comma-separated.",
    );
    reopened.expectOk();
    reopened.noFailedActions();
    reopened.calledTool("read_file", { count: 1 });
    reopened.notCalledTool(TOOL_NAME);
    t.eventsSatisfy("the reopened image answers the follow-up", (events) => {
      const answer = assistantAnswers(reopened.events).at(-1);
      return answer !== undefined && namesColorsInOrder(events, answer);
    }).soft();
  },
});

/** Where eve stages a tool-result file: its content hash and filename. */
function stagedImagePath(base64: string): string {
  const sha = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
  return `/workspace/.eve/attachments/${sha.slice(0, 16)}/stripes.png`;
}

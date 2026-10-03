import { defineEval } from "eve/evals";

import {
  assistantAnswers,
  isRenderStripesOutput,
  namesColorsInOrder,
  TOOL_NAME,
} from "./render-stripes-shared";

// The stripe colors are randomized per run, so a blind model cannot pass by
// guessing; the eval stays self-contained by validating the reply against
// the answer key the tool records on action.result. The pixels reach the
// model exclusively through `toModelOutput` content parts. Color recognition
// remains tracked rather than gated because live vision quality varies; the
// fixture's mock model decodes the pixels and fails the turn when they are
// missing, so world suites gate on the image reaching every call.
export default defineEval({
  description: "Static tools smoke: toModelOutput content parts deliver an image to the model.",
  async test(t) {
    const { session } = await t.send(
      `Call \`${TOOL_NAME}\` exactly once, look at the rendered image, and reply with only ` +
        "the stripe colors left to right, comma-separated.",
    );

    t.succeeded();
    t.noFailedActions();
    t.calledTool(TOOL_NAME, { count: 1, output: isRenderStripesOutput });
    t.eventsSatisfy("a reply names the rendered colors in order", (events) => {
      const answer = assistantAnswers(events)[0];
      return answer !== undefined && namesColorsInOrder(events, answer);
    }).soft();

    // History keeps a sandbox ref to the image and every model call hydrates
    // it, so a follow-up turn answers from replay without re-running the tool.
    await session.send(
      "Without calling any tool, repeat the stripe colors left to right, comma-separated.",
    );

    t.succeeded();
    t.calledTool(TOOL_NAME, { count: 1 });
    t.eventsSatisfy("the replayed image still answers the follow-up", (events) => {
      const answer = assistantAnswers(events).at(-1);
      return answer !== undefined && namesColorsInOrder(events, answer);
    }).soft();
  },
});

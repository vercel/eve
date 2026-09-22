import { defineEval } from "eve/evals";
import {
  scriptedSession,
  expectReply,
  expectResponseReply,
  expectToolResult,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "Two unanswered questions cannot swallow a tool reply even when no approval remains.",
  tags: ["hitl", "continuation", "regression", "user-message", "question"],
  timeoutMs: 60_000,
  async test(t) {
    // Given two questions remain unanswered after the only approval is cancelled.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approval = requestFrom(first, "change-a");
    const session = first.session;
    const color = await session.send("Ask which color to use, then read the draft status.");
    const colorRequest = requestFrom(color, "ask_question");
    const size = await session.send("Ask which size to use.");
    const sizeRequest = requestFrom(size, "ask_question");
    await expectResponseReply(
      t,
      await session.startRespond([{ requestId: approval.requestId, optionId: "cancel" }]),
      "Change A resolved.",
      approval.requestId,
    );
    session.notEvent("action.result", {
      data: { status: "completed", result: { toolName: "change-a" } },
    });

    // When the user asks to read the draft.
    const live = await session.start("Read the draft status.");

    // Then the read gets a completed reply and neither question is silently answered.
    await expectToolResult(t, live, "read-draft");
    await expectReply(t, live, "Draft status: ready.");
    session.eventsSatisfy("Neither unanswered question was silently resolved", (events) =>
      events.every(
        (event) =>
          event.type !== "input.resolved" ||
          event.data.resolutions.every(
            (resolution) =>
              resolution.requestId !== colorRequest.requestId &&
              resolution.requestId !== sizeRequest.requestId,
          ),
      ),
    );
    await expectResponseReply(
      t,
      await session.startRespond([{ requestId: colorRequest.requestId, optionId: "red" }]),
      "Draft status: ready.",
      colorRequest.requestId,
    );
    await expectResponseReply(
      t,
      await session.startRespond([{ requestId: sizeRequest.requestId, optionId: "small" }]),
      "Size resolved.",
      sizeRequest.requestId,
    );
  },
});

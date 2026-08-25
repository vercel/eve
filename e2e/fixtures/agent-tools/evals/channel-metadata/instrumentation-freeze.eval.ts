import { defineEval } from "eve/evals";

import { startChannelSession } from "./shared";

const TOOL_NAME = "instrumentation-snapshot";

export default defineEval({
  tags: ["real-model"],
  description: "Legacy instrumentation freezes channel classification when the session is created.",
  async test(t) {
    const sessionId = await startChannelSession(t.target, "/metadata-provider/start", {
      audience: "public",
      message: `Call the ${TOOL_NAME} tool exactly once, then report its result.`,
      mutateAudienceOnTurn: true,
      topic: "instrumentation-freeze",
    });
    const session = await t.target.attachSession(sessionId);

    session.succeeded();
    session.calledTool(TOOL_NAME, {
      count: 1,
      output: (value: unknown) =>
        isRecord(value) &&
        isRecord(value.frozen) &&
        value.frozen.kind === "channel:metadata-provider" &&
        isRecord(value.frozen.metadata) &&
        value.frozen.metadata.audience === "public" &&
        isRecord(value.live) &&
        value.live.audience === "private",
    });
    session.noFailedActions();
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

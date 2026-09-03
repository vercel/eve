import { defineEval } from "eve/evals";

const SUBAGENT_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";

/**
 * Local subagent delegation: the `echo-marker` child's instructions pin its
 * reply to the exact SUBAGENT_TOKEN string, so the token in the parent's final
 * message proves the child's output was spliced back into the conversation.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Local subagent delegation smoke: child output reaches the parent reply verbatim.",
  async test(t) {
    const started = await t.send(
      "Use the echo-marker subagent with message 'ping'. Once it returns, reply with the subagent's exact output included verbatim.",
    );
    started.expectOk();
    const completed = await t.target
      .watchTurn(started.sessionId, { startIndex: requireStreamIndex(t) })
      .result();
    completed.expectOk();
    completed.messageIncludes(SUBAGENT_TOKEN);

    t.succeeded();
    t.calledSubagent("echo-marker", { count: 1 });
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Parent session has no stream index.");
  return streamIndex;
}

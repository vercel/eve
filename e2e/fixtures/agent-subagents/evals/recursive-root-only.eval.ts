import { defineEval } from "eve/evals";

const CHILD_TOKEN = "RECURSIVE_AGENT_NOT_AVAILABLE";

/** Runtime copies do not receive the root-only built-in `agent` tool. */
export default defineEval({
  tags: ["real-model"],
  description: "The built-in recursive agent tool is exposed only to the root session.",
  async test(t) {
    const started = await t.send(
      [
        "Use the built-in agent subagent exactly once.",
        "Give the child this task:",
        "If a built-in tool named `agent` is visible, call it once and return RECURSIVE_AGENT_WAS_VISIBLE.",
        `If no built-in tool named \`agent\` is visible, return exactly ${CHILD_TOKEN}.`,
        `After the child returns, reply with its exact output and no other token.`,
      ].join(" "),
    );
    started.expectOk();

    const completed = await t.target
      .watchTurn(started.sessionId, { startIndex: requireStreamIndex(t) })
      .result();
    completed.expectOk();
    completed.messageIncludes(CHILD_TOKEN);

    t.succeeded();
    t.calledSubagent("agent", { count: 1 });
    t.noFailedActions();
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Parent session has no stream index.");
  return streamIndex;
}

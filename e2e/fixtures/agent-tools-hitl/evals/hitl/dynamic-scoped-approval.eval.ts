import { defineEval } from "eve/evals";

const TOOL_NAME = "dynamic_scoped_approval";

export default defineEval({
  description:
    "Dynamic input-scoped approval grants survive replay without authorizing other scopes.",
  async test(t) {
    const first = await t.send(`Call the ${TOOL_NAME} tool exactly once with scope "repo-a".`);
    const session = first.session;
    first.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    session.requireInputRequest({ toolName: TOOL_NAME });
    const approved = await session.respondAll("approve");
    approved.expectOk();
    approved.calledTool(TOOL_NAME, { status: "completed", count: 1 });

    const repeated = await session.send(
      `Call the ${TOOL_NAME} tool exactly once with scope "repo-a".`,
    );
    repeated.succeeded();
    repeated.calledTool(TOOL_NAME, { status: "completed", count: 1 });

    const other = await session.send(
      `Call the ${TOOL_NAME} tool exactly once with scope "repo-b".`,
    );
    other.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    session.requireInputRequest({ toolName: TOOL_NAME });
    const approvedOther = await session.respondAll("approve");
    approvedOther.expectOk();
    t.succeeded();
    t.calledTool(TOOL_NAME, { status: "completed", count: 3 });
  },
});

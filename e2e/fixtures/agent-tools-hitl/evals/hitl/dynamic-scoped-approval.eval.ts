import { defineEval } from "eve/evals";

const TOOL_NAME = "dynamic_scoped_approval";

export default defineEval({
  description:
    "Dynamic input-scoped approval grants survive replay without authorizing other scopes.",
  async test(t) {
    const first = await t.send(`Call the ${TOOL_NAME} tool exactly once with scope "repo-a".`);
    first.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    t.requireInputRequest({ toolName: TOOL_NAME });
    const approved = await t.respondAll("approve");
    approved.expectOk();
    approved.calledTool(TOOL_NAME, { status: "completed", count: 1 });

    const repeated = await t.send(`Call the ${TOOL_NAME} tool exactly once with scope "repo-a".`);
    repeated.succeeded();
    repeated.calledTool(TOOL_NAME, { status: "completed", count: 1 });

    const other = await t.send(`Call the ${TOOL_NAME} tool exactly once with scope "repo-b".`);
    other.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    t.requireInputRequest({ toolName: TOOL_NAME });
    const approvedOther = await t.respondAll("approve");
    approvedOther.expectOk();
    t.succeeded();
    t.calledTool(TOOL_NAME, { status: "completed", count: 3 });
  },
});

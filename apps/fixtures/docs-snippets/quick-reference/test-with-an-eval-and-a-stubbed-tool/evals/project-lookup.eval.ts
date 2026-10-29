import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Looks up a project with get_project.",
  async test(t) {
    const session = await t.session({
      stubs: [
        { id: "project", tool: "get_project", outcome: { response: { status: "on track" } } },
      ],
    });
    const turn = await session.send("How is project 42 doing?");
    t.succeeded();
    t.calledTool("get_project");
    t.check(turn.reply, includes("on track"));
  },
});

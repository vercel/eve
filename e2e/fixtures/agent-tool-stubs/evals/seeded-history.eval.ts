import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description:
    "A real model answers from fixed session history and uses a stubbed tool without repeating earlier lookups.",
  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; fixed session history is dev-only.");
    }

    const session = await t.session({
      history: [
        { role: "user", text: "Alice asks: what open tasks do I have?" },
        {
          role: "assistant",
          text: "You have three open tasks: Buy milk (id: milk), Walk dog (id: dog), and Pay rent (id: rent).",
        },
      ],
      stubs: [
        {
          id: "complete-milk",
          tool: "complete_task",
          match: { task_id: { const: "milk" } },
          outcome: { response: { success: true } },
        },
      ],
    });

    const turn = await session.send("Please mark Buy milk as completed now.");
    turn.expectOk();
    turn.calledTool("complete_task", {
      input: { task_id: "milk" },
      output: { success: true },
      count: 1,
    });
    turn.notCalledTool("list_tasks");
    session.event("turn.settled", { count: 1 });
    t.noFailedCalls();
  },
});

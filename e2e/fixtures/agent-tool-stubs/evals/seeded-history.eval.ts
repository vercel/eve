import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description:
    "A real model reads task IDs from an imported tool result in fixed history and completes the named task before listing remaining tasks.",
  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; fixed session history is dev-only.");
    }

    const session = await t.session({
      history: [
        { role: "user", text: "Alice asks: what open tasks do I have?" },
        {
          role: "assistant",
          parts: [
            {
              type: "tool",
              name: "list_tasks",
              input: {},
              output: {
                tasks: [
                  { id: "milk", title: "Buy milk" },
                  { id: "dog", title: "Walk dog" },
                  { id: "rent", title: "Pay rent" },
                ],
              },
            },
            {
              type: "text",
              text: "You have three open tasks: Buy milk, Walk dog, and Pay rent.",
            },
          ],
        },
      ],
      stubs: [
        {
          id: "complete-milk",
          tool: "complete_task",
          match: { task_id: { const: "milk" } },
          outcome: { response: { success: true } },
        },
        {
          id: "remaining-tasks",
          tool: "list_tasks",
          outcome: {
            response: {
              tasks: [
                { id: "dog", title: "Walk dog" },
                { id: "rent", title: "Pay rent" },
              ],
            },
          },
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
    turn.calledTool("list_tasks", { count: 1 });
    turn.toolOrder(["complete_task", "list_tasks"]);
    turn.messageIncludes("Walk dog");
    turn.messageIncludes("Pay rent");
    session.event("turn.settled", { count: 1 });
    t.noFailedCalls();
  },
});

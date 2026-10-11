import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  judge: { model: e2eJudgeModel() },
  description:
    "A model lists stubbed tasks, completes the intended task, and reports the remaining tasks in a follow-up turn.",
  async test(t) {
    const session = await t.session({
      stubs: [
        {
          id: "tasks",
          tool: "list_tasks",
          outcomes: [
            {
              response: {
                tasks: [
                  { id: "milk", title: "Buy milk" },
                  { id: "dog", title: "Walk dog" },
                  { id: "rent", title: "Pay rent" },
                ],
              },
            },
            {
              response: {
                tasks: [
                  { id: "dog", title: "Walk dog" },
                  { id: "rent", title: "Pay rent" },
                ],
              },
            },
          ],
        },
        {
          id: "complete-milk",
          tool: "complete_task",
          match: { task_id: { const: "milk" } },
          outcome: { response: { success: true } },
        },
      ],
    });

    const first = await session.send("Alice asks: what open tasks do I have?");
    first.expectOk();
    first.calledTool("list_tasks", { count: 1 });
    first.notCalledTool("complete_task");
    first.messageIncludes("Buy milk");
    first.messageIncludes("Walk dog");
    first.messageIncludes("Pay rent");

    const second = await session.send(
      "Please complete Buy milk, then list only the tasks that are still open.",
    );
    second.expectOk();
    second.calledTool("complete_task", {
      input: { task_id: "milk" },
      output: { success: true },
      count: 1,
    });
    second.calledTool("list_tasks", { count: 1 });
    second.toolOrder(["complete_task", "list_tasks"]);
    second.messageIncludes("Walk dog");
    second.messageIncludes("Pay rent");
    t.judge(
      "The response identifies Walk dog and Pay rent as the only remaining open tasks. " +
        "It may acknowledge that Buy milk was completed, but must not present Buy milk as still open.",
      { on: second.message },
    ).gate(0.8);
    t.noFailedActions();
  },
});

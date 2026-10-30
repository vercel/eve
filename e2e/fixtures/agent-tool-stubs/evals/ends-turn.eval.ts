import { defineEval } from "eve/evals";

const tasks = { tasks: [{ id: "milk", title: "Buy milk" }] };

const listTasks = defineEval({
  description:
    "A stub response with endsTurn ends the turn after its call, without another model call.",
  async test(t) {
    const session = await t.session({
      stubs: [{ id: "tasks", tool: "list_tasks", outcome: { response: tasks, endsTurn: true } }],
    });
    const turn = await session.send("Alice asks: what open tasks do I have?");
    turn.expectOk();
    turn.calledTool("list_tasks", { output: tasks, count: 1 });
    turn.eventsSatisfy(
      "the model is not called after the stubbed call",
      (events) => events.filter((event) => event.type === "model.requested").length === 1,
    );
    turn.eventsSatisfy(
      "the turn completes without a reply",
      (events) =>
        !turn.reply &&
        events.some((event) => event.type === "turn.settled" && event.data.outcome === "completed"),
    );
  },
});

const research = "Three sources agree.";

const delegate = defineEval({
  description: "A stubbed agent's endsTurn response ends the turn once its result is in.",
  async test(t) {
    const session = await t.session({
      stubs: [
        { id: "researcher", tool: "researcher", outcome: { response: research, endsTurn: true } },
      ],
    });
    const turn = await session.send("Alice asks: Ask the researcher what the sources say.");
    turn.expectOk();
    turn.calledAgent("researcher", { status: "completed", count: 1 });
    turn.eventsSatisfy(
      "the model is not called after the delegation",
      (events) => events.filter((event) => event.type === "model.requested").length === 1,
    );
    turn.eventsSatisfy(
      "the turn completes without a reply",
      (events) =>
        !turn.reply &&
        events.some((event) => event.type === "turn.settled" && event.data.outcome === "completed"),
    );
  },
});

export default [listTasks, delegate];

import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { defaultMessageReducer } from "eve/client";

const RESULT = "EXPORT-COMPLETE";

export default defineEval({
  description:
    "A background workflow streams progress and delivers one terminal report to the parent.",
  async test(t) {
    const started = await t.send("BACKGROUND-EXPORT-START");
    const conversation = started.session;
    started.expectOk();
    started.calledTool("export");

    const receipt = started.requireToolCall("export");
    const taskId = readTaskId(receipt.output);
    if (taskId === undefined) throw new Error("export receipt is missing taskId.");

    const sessionId = conversation.sessionId;
    if (sessionId === undefined) throw new Error("Eval has no parent session id.");

    const doneLive = t.target.watchTurn(sessionId, {
      startIndex: requireStreamIndex(started.session, "completion wait"),
    });
    const doneTurn = await doneLive.result();
    doneTurn.expectOk();
    doneTurn.messageIncludes("BACKGROUND-EXPORT-DONE");
    doneTurn.event("message.received", {
      data: (data) => data.kind === "execution.background_task",
      count: 1,
    });

    const reducer = defaultMessageReducer();
    const projection = [...started.events, ...doneTurn.events].reduce(
      (data, event) => reducer.reduce(data, event),
      reducer.initial(),
    );
    await t.require(
      projection.messages,
      satisfies(
        (messages: typeof projection.messages) =>
          messages.filter((message) => message.role === "user").length === 1 &&
          messages.some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some(
                (part) => part.type === "text" && part.text.includes("BACKGROUND-EXPORT-DONE"),
              ),
          ),
        "frontend projection keeps the background result without rendering runtime task input",
      ),
    );
    doneTurn.event("turn.started", { count: 1 });
    doneTurn.notEvent("message.received", {
      data: (data) => messageText(data.message).includes("PROGRESS"),
    });
    t.noFailedActions();
  },
});

function readTaskId(output: unknown): string | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const taskId = Reflect.get(output, "taskId");
  return typeof taskId === "string" ? taskId : undefined;
}

function requireStreamIndex(
  session: { readonly state?: { readonly streamIndex?: number } },
  operation: string,
): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error(`${operation} has no session stream index.`);
  return streamIndex;
}

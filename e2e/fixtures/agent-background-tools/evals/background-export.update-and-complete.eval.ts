import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const PROGRESS = "EXPORT-PROGRESS";
const RESULT = "EXPORT-COMPLETE";

export default defineEval({
  description:
    "An authored background defineTool posts one task update then completes; the parent sees both.",
  async test(t) {
    const started = await t.send("BACKGROUND-EXPORT-START");
    started.expectOk();
    started.calledTool("export");

    const receipt = started.requireToolCall("export");
    const taskId = readTaskId(receipt.output);
    if (taskId === undefined) throw new Error("export receipt is missing taskId.");

    const sessionId = t.sessionId;
    if (sessionId === undefined) throw new Error("Eval has no parent session id.");

    const updateLive = t.target.watchTurn(sessionId, {
      startIndex: requireStreamIndex(t, "update wait"),
    });
    const updateTurn = await updateLive.result();
    updateTurn.expectOk();
    updateTurn.messageIncludes("BACKGROUND-EXPORT-UPDATE-RECEIVED");
    await t.require(
      updateTurn.events,
      satisfies(
        (events: typeof updateTurn.events) =>
          events.some(
            (event) =>
              event.type === "message.received" &&
              messageText(event.data.message).includes(
                `Background task ${taskId} (export) update: ${PROGRESS}`,
              ),
          ),
        "parent receives the executor update with task identity",
      ),
    );

    const doneLive = t.target.watchTurn(sessionId, {
      startIndex: requireStreamIndex(updateLive.session, "completion wait"),
    });
    const doneTurn = await doneLive.result();
    doneTurn.expectOk();
    doneTurn.messageIncludes("BACKGROUND-EXPORT-DONE");
    await t.require(
      doneTurn.events,
      satisfies(
        (events: typeof doneTurn.events) =>
          events.some(
            (event) =>
              event.type === "message.received" &&
              messageText(event.data.message).includes(
                `Background task ${taskId} (export) is completed.`,
              ) &&
              messageText(event.data.message).includes(RESULT),
          ),
        "parent receives the executor completion with task identity",
      ),
    );
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

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .flatMap((part) =>
      part !== null &&
      typeof part === "object" &&
      Reflect.get(part, "type") === "text" &&
      typeof Reflect.get(part, "text") === "string"
        ? [Reflect.get(part, "text") as string]
        : [],
    )
    .join("\n");
}

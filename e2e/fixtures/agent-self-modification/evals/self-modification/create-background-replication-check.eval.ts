import { randomUUID } from "node:crypto";

import { defineEval, type EveEvalTurn } from "eve/evals";

import { withSelfModification } from "./harness";

const TOOL_NAME = "eval_replication_check";
const TOOL_PATH = `tools/${TOOL_NAME}.ts`;

export default defineEval({
  tags: ["real-model"],
  description:
    "A background workflow tool created through self-modification is callable on the next turn of the same session and later reports its result.",

  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      const previousRevision = await selfMod.runtimeRevision();
      const authored = await selfMod.request(
        [
          `Alice needs a reusable local background workflow named ${TOOL_NAME} for checking a replicated import in future conversations.`,
          "Accept batchId as a non-empty string and expectedRecords as an integer from 1 through 1000000.",
          "When invoked, start in the background, wait for 10 seconds, and then return structured data containing success set to true, the unchanged batchId and expectedRecords, and status set to ready.",
          "The initial call must return a background task receipt immediately rather than blocking the conversation for the wait.",
          "This workflow only simulates the replication wait. It must not read files, contact external services, or modify data.",
        ].join(" "),
      );
      await selfMod.readSource(TOOL_PATH);
      await selfMod.assertOnlyChanged([TOOL_PATH]);
      await selfMod.waitForRebuild(previousRevision);

      const batchId = `batch-${randomUUID()}`;
      const expectedRecords = 137;
      const started = await selfMod.followUp(
        authored.session,
        [
          `Start ${TOOL_NAME} exactly once for batchId ${JSON.stringify(batchId)} and expectedRecords ${expectedRecords}.`,
          "Acknowledge its background task receipt without claiming the check is finished.",
          "When the background task completes, report its returned result.",
        ].join(" "),
      );
      started.expectOk();
      started.calledTool(TOOL_NAME, { count: 1 });
      const call = started.requireToolCall(TOOL_NAME, {
        input: { batchId, expectedRecords },
      });
      const taskId = readWorkingTaskId(call.output);
      if (taskId === undefined) {
        throw new Error(`${TOOL_NAME} did not immediately return a working task receipt.`);
      }

      const receiptAt = actionResultTime(started.events, taskId);
      const completion = await t.target
        .watchTurn(authored.session.sessionId!, {
          startIndex: requireStreamIndex(authored.session),
        })
        .result();
      completion.expectOk();
      completion.messageIncludes(batchId);
      completion.messageIncludes("ready");
      completion.eventsSatisfy(
        "completion reports the positive result after the ten-second wait",
        (events) =>
          events.some((event) => {
            if (event.type !== "message.received") return false;
            const text = messageText(event.data.message);
            return (
              Date.parse(event.meta.at) - receiptAt >= 9_500 &&
              Date.parse(event.meta.at) - receiptAt <= 20_000 &&
              text.includes(`Background task ${taskId} (${TOOL_NAME}) is completed.`) &&
              text.includes(batchId) &&
              text.includes(String(expectedRecords)) &&
              text.includes("true") &&
              text.includes("ready")
            );
          }),
      );
      t.noFailedActions();
      t.succeeded();
    });
  },
});

function readWorkingTaskId(output: unknown): string | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const taskId = Reflect.get(output, "taskId");
  const status = Reflect.get(output, "status");
  return typeof taskId === "string" && status === "working" ? taskId : undefined;
}

function actionResultTime(events: EveEvalTurn["events"], taskId: string): number {
  const result = events.find(
    (event) =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === TOOL_NAME &&
      readWorkingTaskId(event.data.result.output) === taskId,
  );
  if (result === undefined) throw new Error(`${TOOL_NAME} receipt has no action result event.`);
  return Date.parse(result.meta.at);
}

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Background workflow turn has no stream index.");
  return streamIndex;
}

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  return JSON.stringify(message);
}

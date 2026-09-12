import { describe, expect, it } from "vitest";

import { sessionCommandInboxWorkflow } from "#internal/testing/session-inbox-workflow.js";
import { sessionHookPumpWorkflow } from "#internal/testing/session-hook-pump-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getHookByToken, resumeHook, start } from "#internal/workflow/runtime.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { SESSION_INBOX_SESSION_ID_METADATA_KEY } from "#execution/session-inbox/address.js";

describe("session command inbox integration", () => {
  it("pumps a burst across aliases while the owner waits on an independent hook", async () => {
    const aliases = ["http:pump:first", "http:pump:second"];
    const releaseToken = "pump:release";
    const run = await start(sessionHookPumpWorkflow, [{ aliases, releaseToken }]);
    const tokens = [sessionCommandHookToken(run.runId), ...aliases];
    try {
      for (const token of [...tokens, releaseToken]) await waitForHook(run, { token });
      const messages = ["one", "two", "three", "four", "five", "six"].map((message) => ({
        kind: "send",
        payload: { message },
      }));
      for (const [index, message] of messages.entries())
        await resumeHook(tokens[index % tokens.length]!, message);
      await resumeHook(releaseToken, undefined);
      await expect(run.returnValue).resolves.toEqual(messages);
    } finally {
      if ((await run.status) === "running") await run.cancel();
    }
  });

  it("stamps the public session id onto every inbox hook", async () => {
    const channelToken = "http:session-inbox:session-id";
    const run = await start(sessionCommandInboxWorkflow, [{ token: channelToken }]);
    const stableToken = sessionCommandHookToken(run.runId);

    try {
      await Promise.all([
        waitForHook({ runId: run.runId }, { token: stableToken }),
        waitForHook({ runId: run.runId }, { token: channelToken }),
      ]);

      for (const token of [stableToken, channelToken]) {
        const hook = await getHookByToken(token);
        const metadata = (await hook.metadata) as Record<string, unknown> | undefined;
        expect(metadata?.[SESSION_INBOX_SESSION_ID_METADATA_KEY], `hook ${token}`).toBe(run.runId);
      }
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("accepts commands alternately through the stable ID and channel aliases", async () => {
    const channelToken = "http:session-inbox:both-aliases";
    const run = await start(sessionCommandInboxWorkflow, [{ token: channelToken }]);
    const stableToken = sessionCommandHookToken(run.runId);

    try {
      await Promise.all([
        waitForHook({ runId: run.runId }, { token: stableToken }),
        waitForHook({ runId: run.runId }, { token: channelToken }),
      ]);

      await resumeHook(stableToken, { kind: "send", payload: { message: "by id" } });
      await resumeHook(channelToken, {
        kind: "deliver",
        payloads: [{ message: "by channel" }],
      });

      await expect(run.returnValue).resolves.toEqual(["by id", "by channel"]);
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("keeps every claimed continuation address active", async () => {
    const oldToken = "http:session-inbox:additive:old";
    const replacementToken = "http:session-inbox:additive:replacement";
    const run = await start(sessionCommandInboxWorkflow, [
      { messageCount: 3, nextToken: replacementToken, token: oldToken },
    ]);

    try {
      await Promise.all([
        waitForHook({ runId: run.runId }, { token: oldToken }),
        waitForHook({ runId: run.runId }, { token: replacementToken }),
      ]);

      await resumeHook(replacementToken, { kind: "send", payload: { message: "replacement" } });
      await resumeHook(oldToken, { kind: "send", payload: { message: "old" } });
      await resumeHook(replacementToken, {
        kind: "send",
        payload: { message: "replacement again" },
      });

      await expect(run.returnValue).resolves.toEqual(["replacement", "old", "replacement again"]);
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  sessionCommandInboxWorkflow,
  sessionInboxForceClaimWorkflow,
  sessionInboxTakeoverWorkflow,
} from "#internal/testing/session-inbox-workflow.js";
import { sessionHookPumpWorkflow } from "#internal/testing/session-hook-pump-workflow.js";
import { waitForHook, startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { getHookByToken, resumeHook, start } from "#internal/workflow/runtime.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import {
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";

describe("session command inbox integration", () => {
  it("pumps a burst across aliases while the owner waits on an independent hook", async () => {
    const aliases = ["http:pump:first", "http:pump:second"];
    const releaseToken = "pump:release";
    const run = await start(sessionHookPumpWorkflow, [{ aliases, releaseToken }]);
    const tokens = [sessionCommandHookToken(run.runId), ...aliases].map(sessionInboxHookToken);
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
    const run = await startSessionOwner(sessionCommandInboxWorkflow, [{ token: channelToken }]);
    const stableToken = sessionInboxHookToken(sessionCommandHookToken(run.runId));

    try {
      await Promise.all([
        waitForHook({ runId: run.runId }, { token: stableToken }),
        waitForHook({ runId: run.runId }, { token: sessionInboxHookToken(channelToken) }),
      ]);

      for (const token of [stableToken, sessionInboxHookToken(channelToken)]) {
        const hook = await getHookByToken(token);
        const metadata = (await hook.metadata) as Record<string, unknown> | undefined;
        expect(metadata?.[SESSION_INBOX_SESSION_ID_METADATA_KEY], `hook ${token}`).toBe(run.runId);
      }
    } finally {
      const status = await run.status;
      if (status === "pending" || status === "running") await run.cancel();
    }
  });

  it("keeps payloads accepted before a forced takeover and can take the address back", async () => {
    const token = "http:session-inbox:takeover";
    const physicalToken = sessionInboxHookToken(token);
    const owner = await start(sessionInboxTakeoverWorkflow, [{ token }]);
    const runs: { cancel(): Promise<unknown>; status: Promise<string> }[] = [owner];
    try {
      await waitForHook(owner, { token: physicalToken });
      const before = [send("one"), send("two")];
      for (const payload of before) await resumeHook(physicalToken, payload);

      const claimer = await start(sessionInboxForceClaimWorkflow, [{ token }]);
      runs.push(claimer);
      // The claimer returns once the original owner has taken the address back.
      await claimer.returnValue;
      await resumeHook(physicalToken, send("three"));

      await expect(owner.returnValue).resolves.toEqual({
        afterReclaim: send("three"),
        beforeTakeover: before,
      });
    } finally {
      for (const run of runs) if ((await run.status) === "running") await run.cancel();
    }
  });
});

function send(message: string) {
  return { kind: "send", payload: { message } } as const;
}

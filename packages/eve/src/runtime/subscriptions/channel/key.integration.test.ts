import { expect, it } from "vitest";

import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { channelSubscriptionKeyWorkflowReference } from "#execution/workflow-references.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { emitChannelSubscriptionEvent } from "./owner.js";
import { channelKeyHookToken, type ChannelKeyMessage } from "./state.js";

it("keeps one run per channel key that accepts events while any subscription holds the key", async () => {
  const run = await startWorkflowOnCurrentDeployment(channelSubscriptionKeyWorkflowReference, [
    { channelName: "github", key: "vercel/eve#7:checks_finished", first: "a" },
  ]);
  const token = channelKeyHookToken("github", "vercel/eve#7:checks_finished");
  const message = (value: ChannelKeyMessage) => resumeHook(token, value);
  try {
    await waitForHook(run, { token });

    await expect(
      emitChannelSubscriptionEvent("github", "vercel/eve#7:checks_finished", { id: "1", data: {} }),
    ).resolves.toBe(true);
    await expect(
      emitChannelSubscriptionEvent("github", "vercel/eve#8:checks_finished", { id: "1", data: {} }),
    ).resolves.toBe(false);

    await message({ kind: "join", bindingId: "b" });
    await message({ kind: "leave", bindingId: "a" });
    await expect(
      emitChannelSubscriptionEvent("github", "vercel/eve#7:checks_finished", { id: "2", data: {} }),
    ).resolves.toBe(true);

    await message({ kind: "leave", bindingId: "b" });
    await run.returnValue;
    await expect(
      emitChannelSubscriptionEvent("github", "vercel/eve#7:checks_finished", { id: "3", data: {} }),
    ).resolves.toBe(false);
  } finally {
    if ((await run.status) === "running") await run.cancel();
  }
});

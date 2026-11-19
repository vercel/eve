import { expect, it } from "vitest";

import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { start } from "#internal/workflow/runtime.js";
import { channelEventWorkflow } from "./workflow.js";
import { findChannelEventOwner, publishChannelEvent, retireChannelEventOwner } from "./owner.js";
import { channelEventHookToken, type ChannelEventBinding } from "./state.js";

const binding: ChannelEventBinding = {
  id: "owner-integration-binding",
  channelName: "github",
  event: "checks_finished",
  arguments: { owner: "vercel", pull: 7, repo: "eve" },
  sessionId: "session-1",
  auth: null,
  executionPrincipal: "anonymous",
  ttlMs: null,
};

it("keeps a subscription as a workflow run that the owner functions find, feed and retire", async () => {
  const run = await start(channelEventWorkflow, [{ binding, serializedContext: {} }]);
  try {
    await waitForHook(run, { token: channelEventHookToken(binding.id) });

    const found = await findChannelEventOwner(binding.id);
    expect(found?.binding).toEqual(binding);
    await expect(findChannelEventOwner("no-such-binding")).resolves.toBeUndefined();

    await expect(publishChannelEvent("no-such-binding", { id: "d", message: "m" })).resolves.toBe(
      false,
    );
    await expect(retireChannelEventOwner("no-such-binding")).resolves.toBe(false);

    await expect(retireChannelEventOwner(binding.id)).resolves.toBe(true);
    await run.returnValue;
    await expect(findChannelEventOwner(binding.id)).resolves.toBeUndefined();
  } finally {
    if ((await run.status) === "running") await run.cancel();
  }
});

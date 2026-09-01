import { describe, expect, it } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import {
  directHookHandoffOwnerPrototypeWorkflow,
  directHookHandoffSuccessorPrototypeWorkflow,
  successorPrototypeSessionToken,
  successorSessionRouterPrototypeWorkflow,
  type SuccessorPrototypeEvent,
} from "#internal/testing/successor-session-prototype.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getHookByToken, getWorld, resumeHook, start } from "#internal/workflow/runtime.js";

describe("successor session topology prototype", () => {
  it("keeps FIFO output and a bounded executor log across successor runs", async () => {
    const messages = ["zero", "one", "two", "three", "four", "five"];
    const router = await start(successorSessionRouterPrototypeWorkflow, [
      { messageCount: messages.length },
    ]);
    const routerToken = successorPrototypeSessionToken(router.runId);
    const eventsPromise = readPrototypeEvents(router.getReadable());

    try {
      await waitForHook(router, { token: routerToken });

      for (const [index, message] of messages.entries()) {
        await resumeHook(routerToken, {
          deliveryId: `delivery-${String(index)}`,
          kind: "deliver",
          message,
        });
      }

      const [result, events] = await Promise.all([router.returnValue, eventsPromise]);

      expect(events).toEqual(
        messages.map((message, index) => ({
          generation: index,
          historyDepth: index + 1,
          message,
          sequence: index,
        })),
      );
      expect(result.processedCount).toBe(messages.length);
      expect(result.executorRunIds).toHaveLength(messages.length);
      expect(new Set(result.executorRunIds).size).toBe(messages.length);

      const executorEventTypes = await Promise.all(
        result.executorRunIds.map((runId) => readWorkflowEventTypes(runId)),
      );
      for (const eventTypes of executorEventTypes.slice(0, -1)) {
        expect(eventTypes.filter((eventType) => eventType === "step_created")).toHaveLength(5);
      }
      expect(
        executorEventTypes.at(-1)?.filter((eventType) => eventType === "step_created"),
      ).toHaveLength(3);
    } finally {
      await cancelIfActive(router);
    }
  });

  it("exposes a HookNotFound gap when a public token moves directly between runs", async () => {
    const suffix = crypto.randomUUID();
    const stableToken = `successor-prototype:direct:${suffix}`;
    const finishToken = `${stableToken}:finish`;
    const claimToken = `${stableToken}:claim`;
    const owner = await start(directHookHandoffOwnerPrototypeWorkflow, [
      { finishToken, stableToken },
    ]);
    const successor = await start(directHookHandoffSuccessorPrototypeWorkflow, [
      { claimToken, stableToken },
    ]);

    try {
      await Promise.all([
        waitForHook(owner, { token: stableToken }),
        waitForHook(successor, { token: claimToken }),
      ]);

      await resumeHook(stableToken, { kind: "release" });
      await waitForHook(owner, { token: finishToken });

      await expect(getHookByToken(stableToken)).rejects.toSatisfy(HookNotFoundError.is);
      await expect(resumeHook(stableToken, { message: "lost during handoff" })).rejects.toSatisfy(
        HookNotFoundError.is,
      );

      await resumeHook(claimToken, undefined);
      await waitForHook(successor, { token: stableToken });
      await resumeHook(stableToken, { message: "accepted after handoff" });

      await expect(successor.returnValue).resolves.toBe("accepted after handoff");
      await resumeHook(finishToken, undefined);
      await expect(owner.returnValue).resolves.toBeUndefined();
    } finally {
      await Promise.all([cancelIfActive(owner), cancelIfActive(successor)]);
    }
  });
});

async function readPrototypeEvents(
  readable: ReadableStream<Uint8Array>,
): Promise<SuccessorPrototypeEvent[]> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SuccessorPrototypeEvent[] = [];

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) events.push(JSON.parse(line) as SuccessorPrototypeEvent);
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) events.push(JSON.parse(buffer) as SuccessorPrototypeEvent);
  return events;
}

async function readWorkflowEventTypes(runId: string): Promise<string[]> {
  const world = await getWorld();
  const eventTypes: string[] = [];
  let cursor: string | undefined;

  do {
    const pagination: { cursor?: string; limit: number } = { limit: 1000 };
    if (cursor !== undefined) pagination.cursor = cursor;
    const page = await world.events.list({ pagination, resolveData: "none", runId });
    eventTypes.push(...page.data.map((event) => event.eventType));
    cursor = page.hasMore === true && page.cursor !== null ? page.cursor : undefined;
  } while (cursor !== undefined);

  return eventTypes;
}

async function cancelIfActive(run: {
  cancel(): Promise<unknown>;
  readonly status: Promise<string>;
}): Promise<void> {
  const status = await run.status;
  if (status === "pending" || status === "running") await run.cancel();
}

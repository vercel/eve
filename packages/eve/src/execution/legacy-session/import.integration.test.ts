import { describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { legacySessionDriverWorkflow } from "#internal/testing/legacy-session-driver-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { hydrateStepReturnValue } from "#compiled/@workflow/core/serialization.js";
import type { DurableStepResult } from "#execution/turn-step.js";
import { getWorld, getHookByToken, start } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resumeSessionInbox, resolveSessionInbox } from "#execution/session-inbox/resume.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";

describe("legacy session import", () => {
  it.each([
    { inputVersion: 0 as const, inboxVersion: 1, streamSnapshot: true },
    { inputVersion: 1 as const, inboxVersion: 3, streamSnapshot: false },
    { inputVersion: 2 as const, inboxVersion: 7, streamSnapshot: false },
    { inputVersion: 2 as const, inboxVersion: 7, streamSnapshot: true, duplicateImport: true },
    { inputVersion: 2 as const, inboxVersion: 7, streamSnapshot: false, committedInput: true },
  ])(
    "imports $inputVersion / inbox $inboxVersion / stream $streamSnapshot / committed $committedInput",
    async (variant) => {
      const runtime = await createTestRuntime({ agent: { name: "legacy-import-current" } });
      {
        await runtime.run(async () => {
          const alias = `http:legacy-${variant.inputVersion}-${variant.streamSnapshot}-${variant.committedInput}`;
          const driver = await start(legacySessionDriverWorkflow, [
            {
              alias,
              ...variant,
              sessionTimeoutMs: false,
              serializedContext: {
                "eve.auth": null,
                "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
                "eve.channel": { kind: "http", state: {} },
                "eve.mode": "conversation",
              },
            },
          ]);
          const stream = captureTurnEvents(driver);
          try {
            await waitForHook(driver, { token: `eve:session:${driver.runId}:inbox` });
            await resumeSessionInbox(
              { sessionId: driver.runId },
              { kind: "send", payload: { message: "Alice asks to continue the blue project." } },
            );
            const first = await stream.nextTurn();
            if (variant.committedInput) {
              expect(filterEventsByType(first, "turn.started")).toHaveLength(0);
              expect(filterEventsByType(first, "step.started")[0]?.data.turnId).toBe("turn_7");
            } else expect(filterEventsByType(first, "turn.started")[0]?.data.turnId).toBe("turn_7");
            expect(filterEventsByType(first, "session.started")).toHaveLength(0);
            expect(filterEventsByType(first, "session.failed")).toHaveLength(0);
            expect(filterEventsByType(first, "message.received")).toHaveLength(
              variant.committedInput ? 0 : 1,
            );
            const owner = await getHookByToken(sessionCommandHookToken(driver.runId));
            expect(owner.runId).not.toBe(driver.runId);
            expect(await driver.status).toBe("running");
            await expect(resolveSessionInbox(alias)).resolves.toEqual({ sessionId: driver.runId });
            await resumeSessionInbox(alias, {
              kind: "send",
              payload: { message: "Bob asks for the next update." },
            });
            const second = await stream.nextTurn();
            expect(filterEventsByType(second, "turn.started")).toHaveLength(1);
            expect((await getHookByToken(sessionCommandHookToken(driver.runId))).runId).toBe(
              owner.runId,
            );
            await vi.waitFor(
              async () => {
                const steps = await (
                  await getWorld()
                ).steps.list({
                  runId: owner.runId,
                  resolveData: "all",
                  pagination: { limit: 1000 },
                });
                const checkpoints: DurableStepResult[] = [];
                for (const step of steps.data) {
                  if (step.stepName.endsWith("//turnStep") && step.output !== undefined) {
                    checkpoints.push(
                      await hydrateStepReturnValue(step.output, owner.runId, undefined),
                    );
                  }
                }
                const saved = checkpoints.find((result) =>
                  result.sessionState.snapshot.session.history.some(
                    (message) =>
                      message.role === "user" &&
                      JSON.stringify(message.content).includes("Bob asks for the next update."),
                  ),
                )?.sessionState.snapshot.session;
                expect(saved).toBeDefined();
                expect(saved!.agent.system).not.toBe("previous deployment");
                expect(saved!.state?.["app.color"]).toBe("blue");
                expect(
                  saved!.history.filter(
                    (message) =>
                      message.role === "user" &&
                      JSON.stringify(message.content).includes(
                        "Alice asks to continue the blue project.",
                      ),
                  ),
                ).toHaveLength(1);
                expect(saved!.history[0]).toMatchObject({
                  role: "user",
                  content: "Alice selected blue for the project.",
                });
              },
              { timeout: 5000 },
            );
            await resumeSessionInbox({ sessionId: driver.runId }, { kind: "reset" });
            const terminal = await stream.nextTurn();
            expect(filterEventsByType(terminal, "session.completed")).toHaveLength(1);
            await expect(driver.returnValue).resolves.toMatchObject({ kind: "done" });
            await expect(stream.nextTurn()).rejects.toThrow(
              "closed before reaching a turn boundary",
            );
          } finally {
            stream.dispose();
            if ((await driver.status) === "running") await driver.cancel();
          }
        });
      }
    },
  );
});

describe("imported session lifetime", () => {
  it("hands off again using a current checkpoint and completes the original stream", async () => {
    const runtime = await createTestRuntime({ agent: { name: "legacy-handoff" } });
    await runtime.run(async () => {
      const driver = await start(legacySessionDriverWorkflow, [
        { alias: "", sessionTimeoutMs: 60_000, serializedContext: legacyContext() },
      ]);
      const stream = captureTurnEvents(driver);
      try {
        await waitForHook(driver, { token: `eve:session:${driver.runId}:inbox` });
        await resumeSessionInbox(
          { sessionId: driver.runId },
          { kind: "send", payload: { message: "Alice continues." } },
        );
        await stream.nextTurn();
        const importedOwner = await getHookByToken(sessionCommandHookToken(driver.runId));
        await resumeSessionInbox(
          { sessionId: driver.runId },
          {
            kind: "send",
            payload: { message: "Bob continues on the next deployment." },
            delivery: {
              acceptedDeploymentId: "dpl_successor",
              channelKind: "http",
              channelName: "test",
              deliveryId: "second",
            },
          },
        );
        await stream.nextTurn();
        const successor = await getHookByToken(sessionCommandHookToken(driver.runId));
        expect(successor.runId).not.toBe(importedOwner.runId);
        expect(await driver.status).toBe("running");
        await resumeSessionInbox({ sessionId: driver.runId }, { kind: "cancel" });
        await resumeSessionInbox(
          { sessionId: driver.runId },
          { kind: "send", payload: { message: "Alice resumes after cancellation." } },
        );
        expect(filterEventsByType(await stream.nextTurn(), "turn.started")).toHaveLength(1);
        await resumeSessionInbox({ sessionId: driver.runId }, { kind: "reset" });
        expect(filterEventsByType(await stream.nextTurn(), "session.completed")).toHaveLength(1);
        await expect(driver.returnValue).resolves.toMatchObject({ kind: "done" });
        await expect(stream.nextTurn()).rejects.toThrow("closed before reaching a turn boundary");
      } finally {
        stream.dispose();
        if ((await driver.status) === "running") await driver.cancel();
      }
    });
  });
  it("expires against the original deadline when import starts after it elapsed", async () => {
    const runtime = await createTestRuntime({ agent: { name: "legacy-timeout" } });
    await runtime.run(async () => {
      const driver = await start(legacySessionDriverWorkflow, [
        { alias: "", sessionTimeoutMs: 1, serializedContext: legacyContext() },
      ]);
      const stream = captureTurnEvents(driver);
      try {
        await waitForHook(driver, { token: `eve:session:${driver.runId}:inbox` });
        await resumeSessionInbox(
          { sessionId: driver.runId },
          { kind: "send", payload: { message: "Alice continues after the deadline." } },
        );
        const events = await stream.nextTurn();
        if (!events.some((event) => event.type === "session.completed"))
          events.push(...(await stream.nextTurn()));
        expect(filterEventsByType(events, "session.completed")).toHaveLength(1);
        await expect(driver.returnValue).resolves.toMatchObject({ kind: "done" });
      } finally {
        stream.dispose();
        if ((await driver.status) === "running") await driver.cancel();
      }
    });
  });
});
function legacyContext() {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: "http", state: {} },
    "eve.mode": "conversation",
  };
}

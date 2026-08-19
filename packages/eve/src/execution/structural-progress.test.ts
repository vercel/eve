import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { CapabilitiesKey, SessionKey, type Session } from "#context/keys.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { createProgressSnapshot, reduceProgressCommand } from "#execution/session-progress.js";
import {
  projectStructuralProgress,
  publishStructuralProgress,
} from "#execution/structural-progress.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({ resumeHook: vi.fn() }));

const root: Session = {
  auth: { current: null, initiator: null },
  sessionId: "root",
  turn: { id: "turn_2", sequence: 2 },
};

type EventDataByType = {
  [TEvent in MessageStreamEvent as TEvent["type"]]: TEvent extends { data: infer TData }
    ? TData
    : never;
};

function stamped<T extends MessageStreamEvent["type"]>(
  type: T,
  data: EventDataByType[T],
  id: string,
): MessageStreamEvent {
  return { data, meta: { at: "2026-08-19T12:00:00.000Z", id }, type } as MessageStreamEvent;
}

describe("projectStructuralProgress", () => {
  it("projects turn and tool lifecycle with session-qualified identities", () => {
    const commands = [
      projectStructuralProgress(root, stamped("turn.started", { sequence: 2, turnId: "t2" }, "1")),
      projectStructuralProgress(
        root,
        stamped(
          "actions.requested",
          {
            actions: [{ callId: "c1", input: {}, kind: "tool-call", toolName: "search" }],
            sequence: 2,
            stepIndex: 0,
            turnId: "t2",
          },
          "2",
        ),
      ),
      projectStructuralProgress(
        root,
        stamped(
          "action.result",
          {
            result: { callId: "c1", kind: "tool-result", output: "done", toolName: "search" },
            sequence: 2,
            status: "completed",
            stepIndex: 0,
            turnId: "t2",
          },
          "3",
        ),
      ),
    ];
    let snapshot = createProgressSnapshot();
    for (const command of commands) snapshot = reduceProgressCommand(snapshot, command!);

    expect(snapshot.turns["turn:root:t2"]?.phase).toBe("running");
    expect(snapshot.entities["action:root:c1"]).toMatchObject({
      kind: "tool",
      label: "search",
      phase: "completed",
    });
  });

  it("projects blockers but excludes narration and output", () => {
    const blocked = projectStructuralProgress(
      root,
      stamped(
        "input.requested",
        {
          requests: [
            {
              action: { callId: "c1", input: {}, kind: "tool-call", toolName: "deploy" },
              kind: "tool-approval",
              prompt: "Approve deployment?",
              requestId: "r1",
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "t2",
        },
        "block",
      ),
    );
    expect(blocked?.events[0]).toMatchObject({
      entity: { kind: "blocker", label: "Approve deployment?", phase: "blocked" },
    });
    expect(
      projectStructuralProgress(
        root,
        stamped(
          "message.appended",
          {
            messageDelta: "secret",
            messageSoFar: "secret",
            sequence: 2,
            stepIndex: 0,
            turnId: "t2",
          },
          "delta",
        ),
      ),
    ).toBeUndefined();
  });

  it("publishes only when the root channel enables progress", async () => {
    const context = new ContextContainer();
    context.set(SessionKey, root);
    const event = stamped("turn.started", { sequence: 2, turnId: "t2" }, "publish");

    await publishStructuralProgress(context, event);
    expect(resumeHook).not.toHaveBeenCalled();
    context.set(CapabilitiesKey, { progress: true });
    await publishStructuralProgress(context, event);
    expect(resumeHook).toHaveBeenCalledWith(
      sessionCommandHookToken("root"),
      expect.objectContaining({ kind: "progress" }),
    );
  });
});

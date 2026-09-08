import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  getPendingDynamicSkillAnnouncement,
  markDynamicSkillAnnouncementPersisted,
  updateDynamicSkillAnnouncement,
} from "#context/dynamic-skill-lifecycle.js";
import { preserveFrameworkStateOnCompaction } from "#execution/compaction.js";
import { ReadFileStateKey } from "#execution/tools/file-state.js";
import { TodoStateKey } from "#execution/tools/todo.js";
import {
  getPendingTaskStateAnnouncement,
  markTaskStateAnnouncementPersisted,
  TASK_DELIVERY_PENDING_INSTRUCTION,
  updateTaskStateAnnouncement,
} from "#tasks/delivery-context.js";
import {
  markDeliveryInstructionPersisted,
  prepareDeliveryInstruction,
  resolveDeliveryPolicy,
} from "#tasks/delivery-policy.js";

function run(setup: (ctx: ContextContainer) => void): {
  ctx: ContextContainer;
  messages: readonly { role: string; content: unknown }[];
} {
  const ctx = new ContextContainer();
  setup(ctx);
  const messages = contextStorage.run(ctx, () => preserveFrameworkStateOnCompaction());
  return { ctx, messages };
}

describe("preserveFrameworkStateOnCompaction", () => {
  it("clears read-before-write stamps so a post-compaction write must re-read", () => {
    const { ctx } = run((c) => {
      c.set(ReadFileStateKey, { byTarget: { "/workspace/foo.ts": {} as never } });
    });

    expect(ctx.require(ReadFileStateKey).byTarget).toEqual({});
  });

  it("re-injects the todo list when present", () => {
    const { messages } = run((c) => {
      c.set(TodoStateKey, {
        items: [{ content: "Ship it", priority: "high", status: "in_progress" }],
      });
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(String(messages[0]?.content)).toContain("[ ] [high] Ship it");
  });

  it("returns no messages when there is no todo list", () => {
    const { messages } = run(() => {});
    expect(messages).toEqual([]);
  });

  it("requeues current framework announcements", () => {
    const ctx = new ContextContainer();
    const skillAnnouncement = "Available skills\n- policy: Tenant policy";
    const taskState = '[Task state]\n{"status":"pending"}';
    const policy = resolveDeliveryPolicy({
      hasOutputSchema: false,
      hasScheduleProvenance: false,
      isChild: false,
      isFirstTurn: false,
      taskDeliveryPhase: "pending",
    });
    updateDynamicSkillAnnouncement(ctx, skillAnnouncement);
    markDynamicSkillAnnouncementPersisted(ctx, skillAnnouncement);
    updateTaskStateAnnouncement(ctx, taskState);
    markTaskStateAnnouncementPersisted(ctx, taskState);
    const instruction = prepareDeliveryInstruction(ctx, policy);
    expect(instruction).toBe(TASK_DELIVERY_PENDING_INSTRUCTION);
    markDeliveryInstructionPersisted(ctx, TASK_DELIVERY_PENDING_INSTRUCTION);

    contextStorage.run(ctx, () => preserveFrameworkStateOnCompaction());

    expect(getPendingDynamicSkillAnnouncement(ctx)).toBe(skillAnnouncement);
    expect(getPendingTaskStateAnnouncement(ctx)).toBe(taskState);
    expect(prepareDeliveryInstruction(ctx, policy)).toBe(TASK_DELIVERY_PENDING_INSTRUCTION);
  });
});

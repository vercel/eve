import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { preserveFrameworkStateOnCompaction } from "#execution/compaction.js";
import { ReadFileStateKey } from "#runtime/framework-tools/file-state.js";
import { TodoStateKey } from "#runtime/framework-tools/todo.js";

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
});

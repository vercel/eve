import { describe, expect, it } from "vitest";

import {
  createTaskInputCapabilityToken,
  readTaskInputTargetToken,
} from "#execution/task-input-capability.js";

const DIGEST = "0123456789abcdef0123456789abcdef";

describe("task input capabilities", () => {
  it("round-trips only an eve create-once session hook", () => {
    const capability = createTaskInputCapabilityToken(`eve:eve:op:${DIGEST}`);

    expect(capability).toBe(`eve:task-input:${DIGEST}`);
    expect(readTaskInputTargetToken(capability)).toBe(`eve:eve:op:${DIGEST}`);
  });

  it.each(["eve:session:victim:inbox", "task:task_1:0123456789abcdef0123456789abcdef"])(
    "does not mint a task-input capability for %s",
    (token) => {
      expect(() => createTaskInputCapabilityToken(token)).toThrow(
        "requires an eve create-once session capability",
      );
    },
  );

  it("rejects malformed task-input capabilities", () => {
    expect(readTaskInputTargetToken("eve:task-input:not-a-digest")).toBeUndefined();
  });
});

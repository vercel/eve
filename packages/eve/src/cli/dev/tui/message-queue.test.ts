import { describe, expect, it } from "vitest";

import { MESSAGE_QUEUE_LIMIT, MessageQueue, renderMessageQueueRows } from "./message-queue.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });

describe("MessageQueue", () => {
  it("queues up to the limit and refuses further messages", () => {
    const queue = new MessageQueue();
    for (let index = 0; index < MESSAGE_QUEUE_LIMIT; index += 1) {
      expect(queue.enqueue(`message ${String(index)}`)).toBe(true);
    }
    expect(queue.full).toBe(true);
    expect(queue.enqueue("one too many")).toBe(false);
  });

  it("drains the whole queue as one coalesced prompt", () => {
    const queue = new MessageQueue();
    queue.enqueue("first");
    queue.enqueue("second");
    expect(queue.takePrompt()).toBe("first\n\nsecond");
    expect(queue.takePrompt()).toBeUndefined();
  });
});

describe("renderMessageQueueRows", () => {
  const render = (queue: MessageQueue) =>
    renderMessageQueueRows({ view: queue.view(), width: 80, theme });

  it("renders nothing while empty", () => {
    expect(render(new MessageQueue())).toEqual([]);
  });

  it("renders one clipped line per message under a counted header", () => {
    const queue = new MessageQueue();
    queue.enqueue("first message\nwith a second line that never shows");
    queue.enqueue("second message");

    const rows = render(queue);
    expect(rows[0]).toContain("↑ Queue 2/5");
    expect(rows[1]).toContain("│ first message");
    expect(rows[1]).not.toContain("second line");
    expect(rows[2]).toContain("└ second message");
  });

  it("marks a full queue", () => {
    const queue = new MessageQueue();
    for (let index = 0; index < MESSAGE_QUEUE_LIMIT; index += 1) queue.enqueue("m");
    expect(render(queue)[0]).toContain("queue full");
  });
});

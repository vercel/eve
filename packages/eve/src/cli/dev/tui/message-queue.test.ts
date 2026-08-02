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
    expect(queue.size).toBe(MESSAGE_QUEUE_LIMIT);
  });

  it("pops the oldest message into the steer payload on Esc", () => {
    const queue = new MessageQueue();
    queue.enqueue("first");
    queue.enqueue("second");

    expect(queue.handleEscape()).toBe("steer");
    expect(queue.view()).toMatchObject({ steering: true, messages: ["second"] });
    expect(queue.takePrompt()).toBe("first");
    // The remaining message stays queued for the steered turn.
    expect(queue.view().messages).toEqual(["second"]);
  });

  it("coalesces repeated Esc pops into one staged steer payload", () => {
    const queue = new MessageQueue();
    queue.enqueue("first");
    queue.enqueue("second");

    expect(queue.handleEscape()).toBe("steer");
    expect(queue.handleEscape()).toBe("steer");
    expect(queue.takePrompt()).toBe("first\n\nsecond");
    expect(queue.idle).toBe(true);
  });

  it("re-reports steer while a steer payload is staged", () => {
    const queue = new MessageQueue();
    queue.enqueue("only");
    queue.handleEscape();

    expect(queue.handleEscape()).toBe("steer");
    expect(queue.view().cancelling).toBe(false);
  });

  it("cancels on the first empty-queue Esc", () => {
    const queue = new MessageQueue();
    expect(queue.handleEscape()).toBe("cancel");
    expect(queue.view().cancelling).toBe(true);
  });

  it("keeps repeated empty-queue Esc cancellation idempotent", () => {
    const queue = new MessageQueue();
    expect(queue.handleEscape()).toBe("cancel");
    expect(queue.handleEscape()).toBe("cancel");
    expect(queue.view().cancelling).toBe(true);
  });

  it("requests direct cancellation without consuming queued messages", () => {
    const queue = new MessageQueue();
    queue.enqueue("follow-up");

    queue.requestCancellation();

    expect(queue.view().cancelling).toBe(true);
    expect(queue.takePrompt()).toBe("follow-up");
  });

  it("drains the whole queue as one coalesced prompt at a turn boundary", () => {
    const queue = new MessageQueue();
    queue.enqueue("first");
    queue.enqueue("second");
    expect(queue.takePrompt()).toBe("first\n\nsecond");
    expect(queue.takePrompt()).toBeUndefined();
  });

  it("restores staged and queued messages into one draft", () => {
    const queue = new MessageQueue();
    queue.enqueue("first");
    queue.enqueue("second");
    queue.handleEscape();

    expect(queue.restoreDraft()).toBe("first\n\nsecond");
    expect(queue.idle).toBe(true);
  });

  it("clears per-turn esc state when a new turn begins", () => {
    const queue = new MessageQueue();
    queue.handleEscape();
    queue.handleEscape();
    queue.beginTurn();
    expect(queue.view().cancelling).toBe(false);
  });
});

describe("renderMessageQueueRows", () => {
  const render = (queue: MessageQueue, working = true) =>
    renderMessageQueueRows({ view: queue.view(), width: 80, theme, working });

  it("renders nothing while idle", () => {
    expect(render(new MessageQueue())).toEqual([]);
  });

  it("renders one clipped line per message under a counted header", () => {
    const queue = new MessageQueue();
    queue.enqueue("first message\nwith a second line that never shows");
    queue.enqueue("second message");

    const rows = render(queue);
    expect(rows[0]).toContain("↑ Queue 2/5");
    expect(rows[0]).toContain("esc steers with the next message");
    expect(rows[1]).toContain("│ first message");
    expect(rows[1]).not.toContain("second line");
    expect(rows[2]).toContain("└ second message");
  });

  it("marks a full queue", () => {
    const queue = new MessageQueue();
    for (let index = 0; index < MESSAGE_QUEUE_LIMIT; index += 1) queue.enqueue("m");
    expect(render(queue)[0]).toContain("queue full");
  });

  it("drops the esc hint when no turn is streaming", () => {
    const queue = new MessageQueue();
    queue.enqueue("waiting");
    expect(render(queue, false)[0]).not.toContain("esc");
  });

  it("shows the steering header while cancellation is in flight", () => {
    const queue = new MessageQueue();
    queue.enqueue("go north");
    queue.enqueue("go south");
    queue.handleEscape();

    const rows = render(queue);
    expect(rows[0]).toContain("Steering — cancelling the running turn…");
    expect(rows[0]).toContain("1/5 still queued");
    expect(rows[1]).toContain("└ go south");
  });

  it("confirms cancellation after one empty-queue Esc", () => {
    const queue = new MessageQueue();
    queue.handleEscape();
    expect(render(queue)).toEqual([expect.stringContaining("Cancelling turn…")]);
  });
});

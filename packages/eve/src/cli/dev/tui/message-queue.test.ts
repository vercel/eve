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

  it("re-reports steer (not armed) while a steer payload is staged", () => {
    const queue = new MessageQueue();
    queue.enqueue("only");
    queue.handleEscape();

    expect(queue.handleEscape()).toBe("steer");
    expect(queue.view().armed).toBe(false);
  });

  it("arms on the first empty-queue Esc and cancels on the second", () => {
    const queue = new MessageQueue();
    expect(queue.handleEscape()).toBe("armed");
    expect(queue.view().armed).toBe(true);
    expect(queue.handleEscape()).toBe("cancel");
    expect(queue.view()).toMatchObject({ armed: true, cancelling: true });
  });

  it("disarms on other activity so a stale Esc cannot cancel", () => {
    const queue = new MessageQueue();
    queue.handleEscape();
    queue.disarm();
    expect(queue.handleEscape()).toBe("armed");
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
    expect(queue.view()).toMatchObject({ armed: false, cancelling: false });
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

  it("teaches the second Esc after arming, and confirms cancellation", () => {
    const queue = new MessageQueue();
    queue.handleEscape();
    expect(render(queue)).toEqual([expect.stringContaining("Press esc again to cancel the turn")]);

    queue.handleEscape();
    expect(render(queue)).toEqual([expect.stringContaining("Cancelling turn…")]);
  });
});

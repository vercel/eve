import { describe, expect, it } from "vitest";

import { sessionHostClock } from "#execution/session/host-clock.js";

describe("sessionHostClock", () => {
  it("keeps one sleep while the deadline stays the same, and answers due when it ends", async () => {
    const sleeps: { readonly at: number; readonly end: () => void }[] = [];
    const host = sessionHostClock(
      { whenPending: () => new Promise<void>(() => {}) },
      (at) => new Promise<void>((end) => sleeps.push({ at, end })),
    );

    const first = host.next({ until: 1_000 });
    const again = host.next({ until: 1_000 });
    expect(sleeps.map(({ at }) => at)).toEqual([1_000]);
    sleeps[0]!.end();
    await expect(first).resolves.toBe("due");
    await expect(again).resolves.toBe("due");

    void host.next({ until: 2_000 });
    expect(sleeps.map(({ at }) => at)).toEqual([1_000, 2_000]);
  });

  it("answers input when the inbox has input first, and woken when its wake settles", async () => {
    let arrive = () => {};
    const host = sessionHostClock(
      { whenPending: () => new Promise<void>((resolve) => (arrive = resolve)) },
      () => new Promise<void>(() => {}),
    );

    const waiting = host.next({ until: 1_000 });
    arrive();
    await expect(waiting).resolves.toBe("input");

    let settle = () => {};
    const woken = host.next({ wake: new Promise<void>((resolve) => (settle = resolve)) });
    settle();
    await expect(woken).resolves.toBe("woken");
  });
});

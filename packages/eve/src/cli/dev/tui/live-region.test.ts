import { describe, expect, it } from "vitest";

import { LiveRegion } from "./live-region.js";
import { MockScreen } from "./test/mock-terminal.js";

function setup() {
  const screen = new MockScreen({ columns: 40, rows: 10 });
  const live = new LiveRegion({ write: (chunk) => screen.write(chunk) });
  return { screen, live };
}

describe("LiveRegion", () => {
  it("repaints the live region in place", () => {
    const { screen, live } = setup();
    live.update(["one", "two"]);
    live.update(["uno", "dos"]);
    expect(screen.snapshot()).toBe("uno\ndos");
  });

  it("commits rows above the live region and keeps them on repaint", () => {
    const { screen, live } = setup();
    live.update(["footer"]);
    live.flush(["committed line"], ["footer"]);
    live.update(["footer 2"]);
    expect(screen.snapshot()).toBe("committed line\nfooter 2");
  });

  it("grows and shrinks the live region without leaving artifacts", () => {
    const { screen, live } = setup();
    live.update(["a", "b", "c"]);
    live.update(["a"]);
    expect(screen.snapshot()).toBe("a");
  });

  it("clears the live region entirely", () => {
    const { screen, live } = setup();
    live.update(["x", "y"]);
    live.clear();
    expect(screen.snapshot()).toBe("");
  });
});

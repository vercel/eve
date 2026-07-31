import { describe, expect, it } from "vitest";

import { LiveRegion } from "./live-region.js";
import { MockScreen } from "#cli/dev/tui/test/mock-terminal.js";

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

  it("parks the hardware cursor on the caret cell", () => {
    const { screen, live } = setup();
    live.update(["header", "> input", "status"], { row: 1, column: 2 });
    // The terminal draws IME composition text at the cursor position; a raw
    // write standing in for that overlay must land on the caret cell.
    screen.write("X");
    expect(screen.snapshot()).toBe("header\n> Xnput\nstatus");
  });

  it("repaints in place after parking the cursor", () => {
    const { screen, live } = setup();
    live.update(["one", "two", "three"], { row: 0, column: 4 });
    live.update(["uno", "dos"]);
    expect(screen.snapshot()).toBe("uno\ndos");
  });

  it("commits rows after parking the cursor", () => {
    const { screen, live } = setup();
    live.update(["footer", "status"], { row: 0, column: 3 });
    live.flush(["committed line"], ["footer", "status"], { row: 0, column: 3 });
    expect(screen.snapshot()).toBe("committed line\nfooter\nstatus");
  });

  it("clamps an out-of-range park position to the live region", () => {
    const { screen, live } = setup();
    live.update(["only"], { row: 5, column: -2 });
    screen.write("X");
    expect(screen.snapshot()).toBe("Xnly");
  });
});

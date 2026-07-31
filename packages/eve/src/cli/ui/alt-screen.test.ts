import { describe, expect, it } from "vitest";

import { AltScreen } from "./alt-screen.js";

function collectingOutput() {
  const writes: string[] = [];
  return {
    writes,
    output: {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    },
  };
}

describe("AltScreen", () => {
  it("enters and exits the alternate buffer once", () => {
    const { writes, output } = collectingOutput();
    const screen = new AltScreen(output);
    screen.enter();
    screen.enter();
    expect(writes.join("")).toBe("\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h");
    expect(screen.active).toBe(true);
    screen.exit();
    screen.exit();
    expect(writes.join("")).toBe(
      "\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?1006l\x1b[?1002l\x1b[?25h\x1b[?1049l",
    );
    expect(screen.active).toBe(false);
  });

  it("paints frames with absolute row positions, clipped to the height", () => {
    const { writes, output } = collectingOutput();
    const screen = new AltScreen(output);
    screen.paint(["ignored"], 10);
    expect(writes).toHaveLength(0);
    screen.enter();
    screen.paint(["one", "two", "three"], 2);
    // Per-row CUP: no reliance on autowrap-pending behavior for full-width rows.
    expect(writes[1]).toBe("\x1b[?2026h\x1b[H\x1b[0J\x1b[1Hone\x1b[2Htwo\x1b[?2026l");
  });
});

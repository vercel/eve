import { describe, expect, it } from "vitest";

import { appendStreamTextDelta } from "#shared/stream-text.js";

describe("appendStreamTextDelta", () => {
  it("starts, appends, and restarts text from UTF-16 offsets", () => {
    expect(appendStreamTextDelta(undefined, 0, "Hel")).toBe("Hel");
    expect(appendStreamTextDelta("Hel", 3, "lo")).toBe("Hello");
    expect(appendStreamTextDelta("Hello", 0, "New")).toBe("New");
    expect(appendStreamTextDelta("😀", 2, "!")).toBe("😀!");
  });

  it("rejects gaps and overlaps", () => {
    expect(appendStreamTextDelta("Hel", 4, "lo")).toBeUndefined();
    expect(appendStreamTextDelta("Hel", 2, "lo")).toBeUndefined();
    expect(appendStreamTextDelta(undefined, 3, "lo")).toBeUndefined();
    expect(appendStreamTextDelta(undefined, undefined as never, "Hel")).toBeUndefined();
    expect(appendStreamTextDelta(undefined, -1, "Hel")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { createSelectOptionCodec } from "./select-option-codec.js";

describe("createSelectOptionCodec", () => {
  it("round-trips values with identical string representations", () => {
    const codec = createSelectOptionCodec<string | number | boolean>([
      { value: 1, label: "Number" },
      { value: "1", label: "String" },
      { value: true, label: "Boolean" },
      { value: "true", label: "Boolean string" },
    ]);

    expect(codec.options.map((option) => option.value)).toEqual([
      "option-0",
      "option-1",
      "option-2",
      "option-3",
    ]);
    expect(codec.decode("option-0")).toBe(1);
    expect(codec.decode("option-1")).toBe("1");
    expect(codec.decode("option-2")).toBe(true);
    expect(codec.decode("option-3")).toBe("true");
  });

  it("rejects duplicate values and unknown keys", () => {
    expect(() =>
      createSelectOptionCodec([
        { value: "same", label: "First" },
        { value: "same", label: "Second" },
      ]),
    ).toThrow("Select option values must be unique");

    const codec = createSelectOptionCodec([{ value: "known", label: "Known" }]);
    expect(() => codec.decode("missing")).toThrow("unknown option key");
  });
});

import { describe, expect, it } from "vitest";

import { createMemoryScope } from "./memory-state.js";

// A memory scope's key names what a memory provider stores under, so it must never change.
describe("memory scope keys", () => {
  it("keep the keys they had when computed with Buffer and node:crypto", () => {
    expect(createMemoryScope({ namespace: "notes", scope: "user-1", slot: "s" }).key).toBe(
      "memscope1_W4Wr5tHmV50E5UT22y_f93LmANEI0YGuVA_mDLPw0LQ",
    );
    expect(
      createMemoryScope({ namespace: "team-notes", scope: ["org", "héllo ✓"], slot: "s" }).key,
    ).toBe("memscope1_abADGbtcz4QxDyHC-e_7i7K21aILXw57FGa2JYAT29g");
    expect(createMemoryScope({ namespace: "n", scope: ["a"], slot: "s" }).key).toBe(
      "memscope1_7MesctD-LLSM2mlcTTsUeHjd3NaZ15kBwNE4ZjJFmfI",
    );
  });
});

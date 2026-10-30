import { describe, expect, it } from "vitest";

import { registryHandoffAddress } from "./runner.js";

const handoff = { address: "eve/slack", status: "needs-terminal" };

describe("registry terminal handoff", () => {
  it("accepts the packaged self-modification subagent's registry install", () => {
    expect(registryHandoffAddress("self-modification__agent", "registry_add", handoff)).toBe(
      "eve/slack",
    );
  });

  it.each([
    ["self-modification__agent", "selfmod__registry_add"],
    ["other-agent", "registry_add"],
  ])("ignores registry-shaped results from %s / %s", (subagent, tool) => {
    expect(registryHandoffAddress(subagent, tool, handoff)).toBeUndefined();
  });

  it.each([null, {}, { ...handoff, status: "installed" }, { ...handoff, address: 42 }])(
    "ignores an incomplete or non-handoff result: %j",
    (output) => {
      expect(
        registryHandoffAddress("self-modification__agent", "registry_add", output),
      ).toBeUndefined();
    },
  );
});

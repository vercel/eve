import { describe, expect, it } from "vitest";

import { disableRoute, isDisabledRouteSentinel } from "#public/definitions/channel.js";

describe("disableRoute", () => {
  it("returns an opaque sentinel only disableRoute() produces", () => {
    const sentinel = disableRoute();

    expect(isDisabledRouteSentinel(sentinel)).toBe(true);
    expect(Object.keys(sentinel)).toEqual([]);
    expect(isDisabledRouteSentinel({ kind: "eve:disabled-channel" })).toBe(false);
  });
});

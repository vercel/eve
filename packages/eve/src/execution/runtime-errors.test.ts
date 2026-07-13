import { describe, expect, it } from "vitest";

import {
  isRuntimeNoActiveSessionError,
  RuntimeNoActiveSessionError,
} from "#execution/runtime-errors.js";

describe("isRuntimeNoActiveSessionError", () => {
  it("recognizes the stable error identity after realm serialization", () => {
    const continuationToken = "http:serialized-session";
    const serializedError = JSON.parse(
      JSON.stringify(new RuntimeNoActiveSessionError(continuationToken)),
    ) as unknown;

    expect(serializedError).toEqual({
      code: "NO_ACTIVE_SESSION",
      continuationToken,
      name: "RuntimeNoActiveSessionError",
    });
    expect(isRuntimeNoActiveSessionError(serializedError)).toBe(true);
  });
});

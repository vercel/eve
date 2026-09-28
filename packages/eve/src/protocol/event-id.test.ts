import { describe, expect, it } from "vitest";

import { isEventId } from "#internal/testing/event-id.js";
import { createEventId } from "#protocol/event-id.js";

describe("createEventId", () => {
  it("prefixes a ULID", () => {
    expect(isEventId(createEventId())).toBe(true);
  });
});

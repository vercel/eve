import { describe, expect, it } from "vitest";

import { isEventId } from "#internal/testing/event-id.js";
import { createEventId, EVENT_ID_PREFIX } from "#protocol/event-id.js";

describe("isEventId", () => {
  it("rejects a bare ULID, a wrong length, or a non-Crockford character", () => {
    const body = createEventId().slice(EVENT_ID_PREFIX.length);

    expect(isEventId(body)).toBe(false);
    expect(isEventId(`${EVENT_ID_PREFIX}${body.slice(1)}`)).toBe(false);
    expect(isEventId(`${EVENT_ID_PREFIX}U${body.slice(1)}`)).toBe(false);
  });
});

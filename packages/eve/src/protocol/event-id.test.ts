import { describe, expect, it } from "vitest";

import { createEventId, EVENT_ID_PREFIX, isEventId } from "#protocol/event-id.js";
import { isUlid } from "#shared/ulid.js";

describe("createEventId", () => {
  it("prefixes a ULID", () => {
    const id = createEventId();

    expect(id.startsWith(EVENT_ID_PREFIX)).toBe(true);
    expect(isUlid(id.slice(EVENT_ID_PREFIX.length))).toBe(true);
  });
});

describe("isEventId", () => {
  it("accepts ids this module mints", () => {
    expect(isEventId(createEventId())).toBe(true);
  });

  it("rejects a bare ULID, a wrong length, or a non-Crockford character", () => {
    const body = createEventId().slice(EVENT_ID_PREFIX.length);

    expect(isEventId(body)).toBe(false);
    expect(isEventId(`${EVENT_ID_PREFIX}${body.slice(1)}`)).toBe(false);
    expect(isEventId(`${EVENT_ID_PREFIX}U${body.slice(1)}`)).toBe(false);
  });
});

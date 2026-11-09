import { describe, expect, it } from "vitest";

import { randomUUID } from "./uuid.web.ts";

describe("the UUIDs the browser build mints", () => {
  it("are distinct version 4 UUIDs", () => {
    const first = randomUUID();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomUUID()).not.toBe(first);
  });
});

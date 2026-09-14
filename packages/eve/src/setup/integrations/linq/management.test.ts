import { describe, expect, it, vi } from "vitest";

import { listLinqPhoneNumbers } from "./management.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Linq management", () => {
  it("lists phone numbers assigned to a partner API token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        phone_numbers: [
          { id: "phone-1", phone_number: "+14155550123" },
          { id: "phone-2", phone_number: "+14155550124" },
        ],
      }),
    );

    await expect(listLinqPhoneNumbers("linq-token", undefined, { fetch })).resolves.toEqual([
      "+14155550123",
      "+14155550124",
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/phone_numbers",
      expect.objectContaining({
        headers: { accept: "application/json", authorization: "Bearer linq-token" },
      }),
    );
  });

  it("reports an API failure without exposing the partner API token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({}, 401));

    await expect(listLinqPhoneNumbers("linq-token", undefined, { fetch })).rejects.toThrow(
      "Could not fetch Linq phone numbers (401)",
    );
  });
});

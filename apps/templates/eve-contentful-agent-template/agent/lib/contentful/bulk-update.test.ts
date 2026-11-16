import { describe, expect, it } from "vitest";

import { contentfulUpdateInputSchema } from "./input-schemas";
import { contentType, createCmaFake, link } from "./testing/cma";
import type { RawContentType } from "./types";
import { updateContentfulFields } from "./update";

const batchInput = (count = 3) => ({
  entries: Array.from({ length: count }, (_, index) => ({
    changes: [
      {
        fieldId: "title",
        operation: "set" as const,
        value: `New title ${index}`,
      },
    ],
    entryId: `entry-${index}`,
    expectedVersion: 10 + index,
  })),
  space: "docs" as const,
});
type Batch = ReturnType<typeof batchInput>;

const modelFields = [
  { id: "title", name: "Title", type: "Symbol" },
] satisfies RawContentType["fields"];

const cma = (batch: Batch) =>
  createCmaFake({
    contentTypes: [contentType("guide", modelFields, "Guide")],
    entries: batch.entries.map(({ entryId, expectedVersion }) => ({
      fields: {
        description: { "en-US": "Preserve" },
        title: { "en-US": "Previous title" },
      },
      sys: {
        contentType: link("guide", "ContentType"),
        id: entryId,
        publishedVersion: expectedVersion - 1,
        version: expectedVersion,
      },
    })),
  });

describe("Contentful bulk field updates", () => {
  it("prepares all 20 entries before saving them with their approved versions", async () => {
    const input = batchInput(20);
    const fake = cma(input);
    const result = await updateContentfulFields(input);
    expect(result.complete).toBe(true);
    expect(result.results).toEqual(
      input.entries.map(({ entryId, expectedVersion }) => ({
        contentfulUrl: `https://app.contentful.com/spaces/sample-docs/environments/master/entries/${entryId}`,
        entryId,
        outcome: "updated",
        previousVersion: expectedVersion,
        status: "changed",
        updatedFields: ["title"],
        version: expectedVersion + 1,
      }))
    );
    const requests = fake.requests();
    const firstWrite = requests.findIndex(({ method }) => method === "PUT");
    expect(firstWrite).toBe(40);
    expect(
      requests.slice(0, firstWrite).every(({ method }) => method === "GET")
    ).toBe(true);
    const writes = requests.slice(firstWrite);
    expect(writes).toHaveLength(20);
    for (const [index, { body, headers, id }] of writes.entries()) {
      expect(id).toBe(`entry-${index}`);
      expect(headers.get("X-Contentful-Version")).toBe(String(10 + index));
      expect(body).toMatchObject({
        fields: {
          description: { "en-US": "Preserve" },
          title: { "en-US": `New title ${index}` },
        },
      });
    }
  });

  it.each([
    [
      "a concurrent edit makes the last entry stale",
      (fake: ReturnType<typeof cma>) => {
        const stale = fake.entries.get("entry-2");
        if (stale) {
          stale.sys.version = 99;
        }
      },
      "Entry entry-2 failed preparation; no entries were saved",
    ],
    [
      "a later entry read is forbidden",
      (fake: ReturnType<typeof cma>) =>
        fake.failWhen(
          ({ id, method }) => method === "GET" && id === "entry-1",
          403
        ),
      "Entry entry-1 failed preparation; no entries were saved: Contentful API returned 403",
    ],
  ] as const)("makes no writes if %s", async (_case, arrange, message) => {
    const input = batchInput();
    const fake = cma(input);
    arrange(fake);
    await expect(updateContentfulFields(input)).rejects.toThrow(message);
    expect(fake.writes()).toEqual([]);
  });

  it("makes no writes if a later entry fails field validation", async () => {
    const input = batchInput();
    input.entries[2].changes[0].fieldId = "unknown";
    const fake = cma(input);
    await expect(updateContentfulFields(input)).rejects.toThrow(
      "Unknown field unknown"
    );
    expect(fake.writes()).toEqual([]);
  });

  it.each([0, 1, 2])(
    "stops on write failure at entry %s and reports every outcome",
    async (failedIndex) => {
      const input = batchInput();
      const fake = cma(input);
      fake.failWhen(
        ({ id, method }) => method === "PUT" && id === `entry-${failedIndex}`,
        () =>
          Response.json({ message: "Changed after preflight" }, { status: 409 })
      );
      const result = await updateContentfulFields(input);
      expect(result.complete).toBe(false);
      expect(result.results).toMatchObject(
        input.entries.map(({ entryId }, index) => {
          let outcome = "notAttempted";
          if (index < failedIndex) {
            outcome = "updated";
          } else if (index === failedIndex) {
            outcome = "failed";
          }
          return { entryId, outcome };
        })
      );
      expect(result.results[failedIndex]).toMatchObject({
        error: "Contentful API returned 409 (Changed after preflight).",
      });
      expect(fake.writes()).toHaveLength(failedIndex + 1);
    }
  );

  it("does not retry an uncertain network failure or continue the batch", async () => {
    const input = batchInput();
    const fake = cma(input);
    fake.failWhen(
      ({ method }) => method === "PUT",
      new TypeError("Connection lost")
    );
    expect(await updateContentfulFields(input)).toEqual({
      complete: false,
      results: [
        { entryId: "entry-0", error: "Connection lost", outcome: "failed" },
        { entryId: "entry-1", outcome: "notAttempted" },
        { entryId: "entry-2", outcome: "notAttempted" },
      ],
    });
    expect(fake.writes()).toHaveLength(1);
  });

  it.each(["GET", "PUT"])(
    "stops after cancellation during %s",
    async (method) => {
      const controller = new AbortController();
      const input = batchInput();
      const fake = cma(input);
      fake.intercept(
        (request) => request.method === method,
        (_request, proceed) => {
          controller.abort();
          return proceed();
        }
      );
      await expect(
        updateContentfulFields(input, controller.signal)
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(
        fake.requests().every(({ init }) => init.signal === controller.signal)
      ).toBe(true);
      expect(fake.writes()).toHaveLength(method === "PUT" ? 1 : 0);
    }
  );

  it("rejects oversized batches, duplicate IDs, and per-entry spaces before requests", async () => {
    const input = batchInput();
    const fake = cma(input);
    const [first] = input.entries;
    const invalid = [
      batchInput(0),
      batchInput(21),
      { ...input, entries: [first, first] },
      { ...input, entries: [{ ...first, space: "site" }] },
      { ...input, entries: [{ ...first, expectedVersion: undefined }] },
      { space: "docs", ...first },
    ];
    for (const value of invalid) {
      expect(contentfulUpdateInputSchema.safeParse(value).success).toBe(false);
    }
    await Promise.all(
      invalid.map((value) =>
        // SAFETY: Deliberately invalid inputs exercise runtime schema rejection independently of TypeScript checks.
        expect(updateContentfulFields(value as Batch)).rejects.toThrow()
      )
    );
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

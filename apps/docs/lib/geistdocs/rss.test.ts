import { describe, expect, it } from "vitest";
import { getFeedUpdatedAt, selectDatedFeedPages } from "./rss";

describe("RSS dates", () => {
  it("keeps every page and uses a stable fallback for untrustworthy source dates", () => {
    const dated = new Date("2026-07-01T00:00:00.000Z");
    const pages = [
      { url: "/dated", data: { lastModified: dated } },
      { url: "/undated", data: {} },
      { url: "/invalid", data: { lastModified: "2026-08-04" } },
    ];

    expect(selectDatedFeedPages(pages)).toEqual([
      { page: pages[0], lastModified: dated },
      { page: pages[1], lastModified: new Date("2026-06-17T00:00:00.000Z") },
      { page: pages[2], lastModified: new Date("2026-06-17T00:00:00.000Z") },
    ]);
  });

  it("uses the latest source date without request-time fallback", () => {
    const pages = selectDatedFeedPages([
      { data: { lastModified: new Date("2026-07-01T00:00:00.000Z") } },
      { data: { lastModified: new Date("2026-07-03T00:00:00.000Z") } },
    ]);

    expect(getFeedUpdatedAt(pages).toISOString()).toBe("2026-07-03T00:00:00.000Z");
    expect(getFeedUpdatedAt([]).toISOString()).toBe("2026-06-17T00:00:00.000Z");
  });
});

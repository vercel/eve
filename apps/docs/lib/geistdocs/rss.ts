const FEED_BASELINE_TIMESTAMP = Date.parse("2026-06-17T00:00:00.000Z");

interface FeedPage {
  data: object;
}

interface DatedFeedPage<Page extends FeedPage> {
  lastModified: Date;
  page: Page;
}

const getLastModified = (data: object): Date | undefined =>
  "lastModified" in data && data.lastModified instanceof Date ? data.lastModified : undefined;

export const selectDatedFeedPages = <Page extends FeedPage>(
  pages: readonly Page[],
): DatedFeedPage<Page>[] =>
  pages.map((page) => ({
    lastModified: getLastModified(page.data) ?? new Date(FEED_BASELINE_TIMESTAMP),
    page,
  }));

export const getFeedUpdatedAt = <Page extends FeedPage>(
  pages: readonly DatedFeedPage<Page>[],
): Date =>
  pages.reduce(
    (latest, { lastModified }) => (lastModified > latest ? lastModified : latest),
    new Date(FEED_BASELINE_TIMESTAMP),
  );

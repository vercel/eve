import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    env: {
      CONTENTFUL_COMPONENT_TYPES:
        '{"sample-docs":["blogPost","component","person","author","callout","card","codeBlock","codeBlockTabs","faqItem","faq","note"],"sample-site":["guide","component","person","author","callout","card","codeBlock","codeBlockTabs","faqItem","faq","note"]}',
      CONTENTFUL_LOCALE: "en-US",
      CONTENTFUL_MANAGEMENT_TOKEN: "test-token",
      CONTENTFUL_PAGE_ROUTES: JSON.stringify({
        blog: {
          contentTypeId: "blogPost",
          spaceId: "sample-site",
          urls: [{ prefix: "blog" }],
        },
        helpGuide: {
          contentTypeId: "guide",
          spaceId: "sample-docs",
          urls: [{ prefix: "help/guide" }],
        },
        helpTopic: {
          contentTypeId: "topic",
          spaceId: "sample-docs",
          urls: [{ prefix: "help" }],
        },
        news: {
          contentTypeId: "newsItem",
          spaceId: "sample-site",
          urls: [{ prefix: "news" }],
        },
        page: {
          contentTypeId: "page",
          spaceId: "sample-site",
          urls: [{ prefix: "p" }],
        },
      }),
      CONTENTFUL_PROTECTED_FIELDS: '["docs/guide/main"]',
      CONTENTFUL_PUBLIC_ORIGIN: "https://example.com",
      CONTENTFUL_SPACE_IDS: '{"docs":"sample-docs","site":"sample-site"}',
    },
    include: ["agent/**/*.test.ts"],
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});

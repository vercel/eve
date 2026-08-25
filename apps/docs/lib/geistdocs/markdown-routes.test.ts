import { describe, expect, it } from "vitest";
import { markdownNotFound, markdownRoutes } from "./markdown-routes";

const integrationsRoute = markdownRoutes.find(({ from }) => from === "/integrations/*path");

const rewriteIntegration = (path: string): string | undefined => {
  if (!integrationsRoute || typeof integrationsRoute.to !== "string") return;
  return integrationsRoute.to.replace("[lang]", "en").replace("*path", path);
};

describe("markdownRoutes", () => {
  it("maps valid integration Markdown requests to the shared route", () => {
    expect(rewriteIntegration("slack")).toBe("/en/llms.mdx/integrations/slack");
  });

  it("maps missing integrations to the smart Markdown handler", () => {
    expect(rewriteIntegration("slak")).toBe("/en/llms.mdx/integrations/slak");
  });

  it("keeps docs Markdown routing intact", () => {
    expect(markdownRoutes).toContainEqual({
      from: "/docs/*path",
      to: "/[lang]/llms.mdx/*path",
    });
  });
});

describe("markdownNotFound", () => {
  it("returns a Markdown 404 for unmatched paths", () => {
    expect(markdownNotFound({ language: "en", pathname: "/no-such-page" })).toBe(true);
  });

  it("lets HTML-only route families continue to the app", () => {
    for (const pathname of ["/templates", "/templates/slack-agent", "/benchmarks", "/resources"]) {
      expect(markdownNotFound({ language: "en", pathname })).toBe(false);
    }
  });

  it("still covers unmapped paths under mapped families", () => {
    expect(markdownNotFound({ language: "en", pathname: "/guides/removed-page" })).toBe(true);
  });
});

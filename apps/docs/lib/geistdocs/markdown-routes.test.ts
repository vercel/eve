import { describe, expect, it } from "vitest";
import { markdownRoutes } from "./markdown-routes";

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

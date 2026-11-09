import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../../app/[lang]/integrations/components/markdown";

const renderAnchor = (markdown: string) =>
  renderToStaticMarkup(createElement(Markdown, { children: markdown })).match(/<a [^>]*>/)?.[0];

describe("integration markdown links", () => {
  // https://github.com/vercel/eve/issues/5434
  it("keeps fragment links in the current tab", () => {
    const anchor = renderAnchor("See [Configure](#configure).");

    expect(anchor).toContain('href="#configure"');
    expect(anchor).not.toContain("target=");
  });

  it("keeps external links in a new tab", () => {
    expect(renderAnchor("See [eve](https://example.com).")).toContain('target="_blank"');
  });
});

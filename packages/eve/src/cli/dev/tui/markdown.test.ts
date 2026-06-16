import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("preserves underscores inside URLs", () => {
    const url =
      "https://connect.vercel.com/authorize/sca_avFI6NnYKKhA1Enmiw9LrgfDRTkNKNlCxbiwRqBkrg";
    expect(renderMarkdown(`URL: ${url}`)).toContain(url);
  });

  it("preserves underscores across multiple URLs on one line", () => {
    const challenge = "https://connect.vercel.com/authorize/sca_token_value";
    const hook =
      "http://localhost:3000/eve/v1/connections/whoami_token/callback/wrun_01KTAJ%3Aauth";
    const rendered = renderMarkdown(`${challenge} ${hook}`);
    expect(rendered).toContain(challenge);
    expect(rendered).toContain(hook);
  });

  it("still applies emphasis to non-URL text", () => {
    expect(renderMarkdown("_italic_")).toBe("\x1b[3mitalic\x1b[23m");
    expect(renderMarkdown("**bold**")).toBe("\x1b[1mbold\x1b[22m");
  });

  it("applies emphasis around a shielded URL", () => {
    const rendered = renderMarkdown("see _https://example.com/a_b_ now");
    expect(rendered).toContain("https://example.com/a_b");
  });
});

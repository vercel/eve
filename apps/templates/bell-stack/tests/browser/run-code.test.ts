import { describe, expect, it } from "vitest";

import { formatRunCode } from "../../server/browser/browser-session.js";

describe("run activity code", () => {
  it("shows exact browser calls and hides entered values", () => {
    const code = formatRunCode([
      { action: "goto", url: "https://example.com/login?token=secret" },
      { action: "fill", target: "#email", value: "person@example.com" },
      { action: "fill", target: "#password", value: "hunter2" },
      { action: "click", target: "button[type=submit]" },
      { action: "press", key: "synthetic-key-input" },
    ]);

    expect(code).toContain("await page.goto");
    expect(code).toContain('page.locator("#email").fill("[value hidden]")');
    expect(code).toContain('page.locator("button[type=submit]").click()');
    expect(code).not.toContain("person@example.com");
    expect(code).not.toContain("hunter2");
    expect(code).not.toContain("token=secret");
    expect(code).not.toContain("synthetic-key-input");
  });
});

import { describe, expect, it } from "vitest";

import { ApprovalContentPanel } from "./approval-content-panel.js";
import { createTheme } from "./theme.js";

const content = {
  type: "text" as const,
  text: "--- agent.ts\n+++ agent.ts\n- old\n+ new\n\n--- new.ts\n+++ new.ts\n+ created",
};
const theme = createTheme({ color: false, unicode: true });

describe("ApprovalContentPanel", () => {
  it("renders tool-provided text without interpreting it", () => {
    const rows = new ApprovalContentPanel(content).render(theme, 80, 30);

    expect(rows.join("\n")).toContain("--- agent.ts");
    expect(rows.join("\n")).toContain("- old");
    expect(rows.join("\n")).toContain("+ new");
    expect(rows.join("\n")).toContain("--- new.ts");
  });

  it("makes undisplayed content explicit", () => {
    const panel = new ApprovalContentPanel({
      type: "text",
      text: Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n"),
    });
    expect(panel.render(theme, 80, 8).join("\n")).toContain("↓ more content");

    panel.move("end", 1, 80, 8);
    const renderedEnd = panel.render(theme, 80, 8).join("\n");
    expect(renderedEnd).toContain("↑ earlier content");
    expect(renderedEnd).not.toContain("↓ more content");

    panel.move("up", 1, 80, 8);
    expect(panel.render(theme, 80, 8).join("\n")).toContain("↓ more content");
  });

  it("pages and toggles visibility", () => {
    const panel = new ApprovalContentPanel(content);
    panel.move("page-down", 4, 20, 8);
    panel.move("page-up", 4, 20, 8);
    expect(panel.render(theme, 20, 8).join("\n")).toContain("--- agent.ts");

    panel.close();
    expect(panel.visible).toBe(false);
    panel.open();
    expect(panel.visible).toBe(true);
  });
});

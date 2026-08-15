import { describe, expect, it } from "vitest";

import { assertWorkflowWorldCompatibility } from "./world-compatibility.js";

const EXPECTED = "5.0.0-beta.24";

describe("assertWorkflowWorldCompatibility", () => {
  it("throws an actionable error when the world targets an older major line", () => {
    expect(() =>
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { dependencies: { "@workflow/core": "^4.2.0" } },
        expectedWorkflowVersion: EXPECTED,
      }),
    ).toThrow(/@workflow\/world-postgres/);
  });

  it("names the incompatible line and the matching install command", () => {
    let thrown: unknown;
    try {
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { dependencies: { "@workflow/core": "4.2.0" } },
        expectedWorkflowVersion: EXPECTED,
      });
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("@workflow/core 4.x");
    expect(message).toContain("5.0.0-beta line");
    expect(message).toContain("pnpm add @workflow/world-postgres@5.0.0-beta.24");
  });

  it("passes when the world targets the same prerelease line", () => {
    expect(() =>
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { dependencies: { "@workflow/core": "5.0.0-beta.20" } },
        expectedWorkflowVersion: EXPECTED,
      }),
    ).not.toThrow();
  });

  it("passes when the world targets the line via a caret range", () => {
    expect(() =>
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { dependencies: { "@workflow/core": "^5.0.0-beta.13" } },
        expectedWorkflowVersion: EXPECTED,
      }),
    ).not.toThrow();
  });

  it("falls back to the @workflow/world dependency when @workflow/core is absent", () => {
    expect(() =>
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { dependencies: { "@workflow/world": "^4.0.0" } },
        expectedWorkflowVersion: EXPECTED,
      }),
    ).toThrow(/@workflow\/world 4\.x/);
  });

  it("reads the declared line from peerDependencies", () => {
    expect(() =>
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { peerDependencies: { "@workflow/core": "^4.0.0" } },
        expectedWorkflowVersion: EXPECTED,
      }),
    ).toThrow(/@workflow\/core 4\.x/);
  });

  it("no-ops when the world declares no @workflow/* dependency", () => {
    expect(() =>
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { dependencies: { "some-other-dep": "1.0.0" } },
        expectedWorkflowVersion: EXPECTED,
      }),
    ).not.toThrow();
  });

  it("no-ops when the declared range is unparseable", () => {
    expect(() =>
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { dependencies: { "@workflow/core": "workspace:*" } },
        expectedWorkflowVersion: EXPECTED,
      }),
    ).not.toThrow();
  });

  it("no-ops when the expected version cannot be parsed", () => {
    expect(() =>
      assertWorkflowWorldCompatibility({
        worldPackageName: "@workflow/world-postgres",
        worldManifest: { dependencies: { "@workflow/core": "^4.0.0" } },
        expectedWorkflowVersion: "not-a-version",
      }),
    ).not.toThrow();
  });
});

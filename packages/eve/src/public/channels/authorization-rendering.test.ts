import { describe, expect, it } from "vitest";

import {
  authorizationDisplayName,
  renderAuthorizationCompleted,
  renderAuthorizationRequired,
} from "#public/channels/authorization-rendering.js";

describe("connection authorization rendering", () => {
  it("falls back to the connection name for a blank authored display name", () => {
    expect(authorizationDisplayName("notion", "  ")).toBe("Notion");
  });

  it("renders every challenge field", () => {
    expect(
      renderAuthorizationRequired({
        authorization: {
          displayName: "Notion Workspace",
          instructions: "Approve access in your browser.",
          url: "https://connect.example.com/auth",
          userCode: "ABCD-1234",
        },
        description: "Connect your account to continue.",
        name: "notion",
      }),
    ).toBe(
      [
        "Authorization required for Notion Workspace.",
        "Connect your account to continue.",
        "Approve access in your browser.",
        "Code: ABCD-1234",
        "Sign in with Notion Workspace: https://connect.example.com/auth",
      ].join("\n\n"),
    );
  });

  it("can omit the credential URL for public status surfaces", () => {
    const rendered = renderAuthorizationRequired({
      authorization: { url: "https://connect.example.com/auth", userCode: "ABCD-1234" },
      description: "Connect your account to continue.",
      includeUrl: false,
      name: "notion",
    });

    expect(rendered).not.toContain("https://");
    expect(rendered).toContain("Code: ABCD-1234");
  });

  it("renders successful and timed-out outcomes", () => {
    expect(renderAuthorizationCompleted({ name: "notion", outcome: "authorized" })).toBe(
      "Notion connected. Resuming.",
    );
    expect(
      renderAuthorizationCompleted({
        name: "notion",
        outcome: "timed-out",
        reason: "Challenge expired",
      }),
    ).toBe("Notion authorization timed out (Challenge expired).");
  });
});

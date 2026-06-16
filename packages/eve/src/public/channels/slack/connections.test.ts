import { describe, expect, it } from "vitest";

import {
  buildAuthCompletedText,
  buildAuthEphemeralBlocks,
  buildAuthRequiredPublicText,
  formatConnectionDisplayName,
} from "#public/channels/slack/connections.js";

describe("formatConnectionDisplayName", () => {
  it("title-cases the first character", () => {
    expect(formatConnectionDisplayName("linear")).toBe("Linear");
  });

  it("returns empty strings unchanged", () => {
    expect(formatConnectionDisplayName("")).toBe("");
  });

  it("leaves already-capitalized names alone", () => {
    expect(formatConnectionDisplayName("GitHub")).toBe("GitHub");
  });
});

describe("buildAuthRequiredPublicText", () => {
  it("invites the triggering user to connect when one is known", () => {
    expect(buildAuthRequiredPublicText({ displayName: "Linear", hasUser: true })).toBe(
      "Connect with Linear to continue",
    );
  });

  it("notes the missing actor when no user is known", () => {
    expect(buildAuthRequiredPublicText({ displayName: "Linear", hasUser: false })).toBe(
      "Authorization required for Linear (no triggering user)",
    );
  });
});

describe("buildAuthCompletedText", () => {
  it("renders the success outcome with a check glyph", () => {
    expect(buildAuthCompletedText({ displayName: "Linear", outcome: "authorized" })).toBe(
      ":white_check_mark: Linear connected",
    );
  });

  it("renders failure outcomes with a cross glyph and the outcome label", () => {
    expect(buildAuthCompletedText({ displayName: "Linear", outcome: "failed" })).toBe(
      ":x: Linear authorization failed",
    );
  });

  it("appends an optional reason in parentheses", () => {
    expect(
      buildAuthCompletedText({
        displayName: "Linear",
        outcome: "declined",
        reason: "user declined consent",
      }),
    ).toBe(":x: Linear authorization declined (user declined consent)");
  });
});

describe("buildAuthEphemeralBlocks", () => {
  it("produces an actions block with a link button to the challenge URL", () => {
    const blocks = buildAuthEphemeralBlocks({
      displayName: "Linear",
      url: "https://connect.example.com/authorize/sca_abc",
    });
    expect(blocks).toHaveLength(1);
    const actions = blocks[0] as { type: string; elements: Array<Record<string, unknown>> };
    expect(actions.type).toBe("actions");
    expect(actions.elements).toHaveLength(1);
    const button = actions.elements[0] as {
      type: string;
      text: { text: string };
      url: string;
      style: string;
    };
    expect(button.type).toBe("button");
    expect(button.text.text).toBe("Sign in with Linear");
    expect(button.url).toBe("https://connect.example.com/authorize/sca_abc");
    expect(button.style).toBe("primary");
  });

  it("prepends a section with the device user code when one is provided", () => {
    const blocks = buildAuthEphemeralBlocks({
      displayName: "Notion",
      url: "https://connect.example.com/authorize/sca_abc",
      userCode: "OTB-DGO",
    });
    expect(blocks).toHaveLength(2);
    const section = blocks[0] as { type: string; text: { text: string } };
    expect(section.type).toBe("section");
    expect(section.text.text).toBe("Use code `OTB-DGO` when prompted.");
    expect((blocks[1] as { type: string }).type).toBe("actions");
  });
});

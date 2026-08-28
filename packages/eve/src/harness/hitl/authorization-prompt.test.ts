import { describe, expect, it } from "vitest";

import {
  AUTHORIZATION_UPDATE_LABEL,
  renderAuthorizationResumeSnippet,
} from "#harness/hitl/authorization-prompt.js";

describe("renderAuthorizationResumeSnippet", () => {
  it("distinguishes completed authorization from the still-pending batch", () => {
    expect(
      renderAuthorizationResumeSnippet({
        authorized: ["notion"],
        pending: ["datadog", "slack"],
      }),
    ).toBe(
      [
        AUTHORIZATION_UPDATE_LABEL,
        "Authorization completed for:",
        '{"name":"notion"}',
        "The following connections are still awaiting authorization. Do not retry them until their callbacks arrive:",
        '{"name":"datadog"}',
        '{"name":"slack"}',
        "Continue based on this updated authorization state.",
      ].join("\n"),
    );
  });

  it("reports when the authorization batch is fully resolved", () => {
    expect(renderAuthorizationResumeSnippet({ authorized: ["notion"], pending: [] })).toContain(
      "No authorization requests remain pending.",
    );
  });
});

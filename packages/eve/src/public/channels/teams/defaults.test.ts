import { describe, expect, it } from "vitest";

import { teamsMentionUser } from "#public/channels/teams/defaults.js";

describe("Teams mention text", () => {
  it.each([
    { name: "Alice", text: "<at>Alice</at>" },
    { name: "Alice & Bob <Support>", text: "<at>Alice &amp; Bob &lt;Support&gt;</at>" },
    { name: "Alice &amp; Bob", text: "<at>Alice &amp;amp; Bob</at>" },
  ])("renders $name as literal mention text", ({ name, text }) => {
    expect(teamsMentionUser({ id: "user-1", name })).toEqual({
      mentioned: { id: "user-1", name },
      text,
      type: "mention",
    });
  });

  it("escapes the ID when no display name is available", () => {
    const mention = teamsMentionUser({ id: "team&user<1>" });

    expect(mention.text).toBe("<at>team&amp;user&lt;1&gt;</at>");
    expect(mention.mentioned.id).toBe("team&user<1>");
  });
});

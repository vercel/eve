import { describe, expect, it } from "vitest";
import { changelogSource } from "./changelog-source";

describe("changelog source", () => {
  it("publishes the eve release history with stable unique entries", async () => {
    const entries = await changelogSource.getEntries({ lang: "en" });
    const release = entries.find(({ version }) => version === "0.52.2");

    expect(release).toMatchObject({
      id: "0.52.2",
      version: "0.52.2",
    });
    expect(release?.body).toContain(
      "Ignore OpenAPI `default` and `example` annotations whose values conflict with the declared schema type",
    );
    expect(release?.body).not.toMatch(/^- [a-f0-9]{7}: /m);
    expect(new Set(entries.map(({ id }) => id)).size).toBe(entries.length);
  });
});

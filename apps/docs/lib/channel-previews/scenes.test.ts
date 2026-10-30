import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { channelPreviews } from "./scenes";

const docsRoot = new URL("../../../../docs/", import.meta.url);

describe("channelPreviews", () => {
  it.each(Object.keys(channelPreviews))("%s names a docs page", (slug) => {
    const candidates = [`${slug}.md`, `${slug}.mdx`, `${slug}/index.md`, `${slug}/index.mdx`];
    expect(candidates.some((path) => existsSync(new URL(path, docsRoot)))).toBe(true);
  });
});
